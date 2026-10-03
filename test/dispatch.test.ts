/**
 * Node → kaneo task → session (docs/design/0003-node-to-session.md), against a fake kaneo
 * and a fake spawn command that records its argv.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const home = temp('eda-dispatch-');
const argvFile = join(home, 'argv');

type FakeTask = { id: string; number: number; title: string; description: string; status: string; projectId?: string };
const tasks = new Map<string, FakeTask>();
const seen: { method: string; path: string; auth: string | null; body: any }[] = [];
/** What the tests turn: how slow a create or a task read is, which body dies mid-answer, and how
 * many task reads were out at once (a pass that piles up on the one before it). */
const knobs = { createMs: 0, getMs: 0, cut: null as string | null, inFlight: 0, maxInFlight: 0 };

/** A connection that ends between the headers and the last byte, as a proxy cut mid-body looks. */
const cutBody = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket) {
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 999\r\n\r\n{"status":"to-do"}');
      socket.end();
    },
  },
});

let madeTasks = 0;
const kaneo = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const body = req.method === 'POST' ? await req.json() : undefined;
    seen.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.get('authorization'), body });
    if (req.headers.get('authorization') !== 'Bearer K') return Response.json({ message: 'unauthorized' }, { status: 401 });
    if (req.method === 'GET' && u.pathname === '/api/project' && u.searchParams.get('workspaceId') === 'W1') {
      return Response.json([{ id: 'p1', name: 'eda' }, { id: 'p2', name: 'ccx' }]);
    }
    const one = /^\/api\/task\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'POST' && one) {
      await Bun.sleep(knobs.createMs);
      // Counted, not sized: a task deleted later must not have its id handed out twice.
      madeTasks += 1;
      const t: FakeTask = { id: `t${madeTasks}`, number: 40 + madeTasks, title: body.title, description: body.description, status: body.status, projectId: one[1]! };
      tasks.set(t.id, t);
      return Response.json(t);
    }
    if (req.method === 'DELETE' && one && tasks.delete(one[1]!)) return Response.json({ ok: true });
    if (req.method === 'GET' && one) {
      knobs.inFlight += 1;
      knobs.maxInFlight = Math.max(knobs.maxInFlight, knobs.inFlight);
      await Bun.sleep(knobs.getMs);
      knobs.inFlight -= 1;
      if (knobs.cut === one[1]) return Response.redirect(`http://127.0.0.1:${cutBody.port}/cut`, 307);
      if (tasks.has(one[1]!)) return Response.json(tasks.get(one[1]!));
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  },
});

const kaneoUrl = `http://127.0.0.1:${kaneo.port}`;

/**
 * The argv the fake command records. `$5` is the repo, which is how each test asks for a
 * different ending: o/fail, o/slow, o/hang, o/loud.
 */
const command = (out = argvFile) => [
  'sh',
  '-c',
  `printf '%s\\n' "$@" > ${out}; if [ "$5" = o/fail ]; then echo boom; exit 3; fi; if [ "$5" = o/slow ]; then sleep 0.5; fi; if [ "$5" = o/hang ]; then while :; do :; done; fi; if [ "$5" = o/loud ]; then printf 'L%.0s' $(seq 1 5000); echo; echo trouble 1>&2; fi; echo started`,
  'spawn',
  '{number}',
  '--project',
  '{project}',
  '--repo',
  '{repo}',
];
/** kaneo with a workspace, and the argv 「session に依頼」 runs (a string in one test, none in another). */
const config = (cmd?: unknown) => ({ kaneo: { host: kaneoUrl, workspace: 'W1' }, ...(cmd === undefined ? {} : { spawn: { command: cmd } }) });

mkdirSync(join(home, 'eda'), { recursive: true });
writeFileSync(join(home, 'eda', 'config.json'), JSON.stringify(config(command())));
process.env['EDA_HOME'] = home;
process.env['XDG_CONFIG_HOME'] = home;
delete process.env['EDA_KANEO_HOST'];
process.env['KANEO_API_KEY'] = 'K';

const { startServer } = await import('../src/server.ts');
const { token } = await import('../src/store.ts');

const dir = temp('eda-map-');
const { server } = startServer({ dir, host: '127.0.0.1', port: 0, title: 'trip', kaneoPollMs: 50 });
afterAll(() => {
  server.stop(true);
  kaneo.stop(true);
  cutBody.stop(true);
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

type Answer = { status: number; json: any };
const ask =
  (base: string) =>
  async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

const person = ask(`http://127.0.0.1:${server.port}`);
const state = async () => (await person('GET', '/api/state')).json;

/**
 * A server on a config and a key of its own, so a test that takes one of them away does not
 * change the map every other test runs on. Both are put back before the next one starts.
 */
const withServer = async (cfg: unknown, key: string | null, run: (call: (method: string, path: string, body?: unknown) => Promise<Answer>) => Promise<void>, kaneoPollMs?: number): Promise<void> => {
  const path = join(home, 'eda', 'config.json');
  const was = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify(cfg));
  if (key === null) delete process.env['KANEO_API_KEY'];
  else process.env['KANEO_API_KEY'] = key;
  const { server: other } = startServer({ dir: temp('eda-map-'), host: '127.0.0.1', port: 0, title: 'other', ...(kaneoPollMs === undefined ? {} : { kaneoPollMs }) });
  try {
    await run(ask(`http://127.0.0.1:${other.port}`));
  } finally {
    other.stop(true);
    process.env['KANEO_API_KEY'] = 'K';
    writeFileSync(path, was);
  }
};

/** A node of its own, so a test that links, creates or deletes does not disturb the trip. */
const spare = async (text: string) => (await person('POST', '/api/nodes', { parentId: 'n1', text })).json.id as string;
const link = async (node: string, task: string, project = 'p1') => person('POST', `/api/nodes/${node}/tasks`, { url: `http://k/dashboard/workspace/W1/project/${project}/task/${task}` });

const hotel = (await person('POST', '/api/nodes', { parentId: 'n1', text: 'hotel' })).json.id as string;
const booking = (await person('POST', '/api/nodes', { parentId: hotel, text: 'book a room near the station' })).json.id as string;
await person('POST', '/api/nodes', { parentId: hotel, text: 'compare prices' });
await person('PATCH', `/api/nodes/${booking}`, { note: 'two nights' });
await person('POST', `/api/nodes/${booking}/urls`, { url: 'https://example.com/hotels' });

test('the state says which kaneo features are available', async () => {
  const s = await state();
  expect(s.kaneo).toEqual({ host: kaneoUrl, status: true, createTask: true, dispatch: true });
  // The host is one field, not two: the browser and the state read the same one.
  expect(s.kaneoHost).toBeUndefined();
});

test('the project picker lists the configured workspace through the kaneo API', async () => {
  const { status, json } = await person('GET', '/api/kaneo/projects');
  expect(status).toBe(200);
  expect(json).toEqual([
    { id: 'p1', name: 'eda' },
    { id: 'p2', name: 'ccx' },
  ]);
});

test('a task made from a node carries the map context and is linked to the node', async () => {
  const { status, json } = await person('POST', `/api/nodes/${booking}/kaneo-task`, { project: 'p1' });
  expect(status).toBe(200);
  expect(json.task).toMatchObject({ id: 't1', number: 41 });

  const sent = seen.find((s) => s.method === 'POST' && s.path === '/api/task/p1')!;
  expect(sent.auth).toBe('Bearer K');
  expect(sent.body.title).toBe('book a room near the station');
  expect(sent.body.status).toBe('to-do');
  expect(sent.body.priority).toBe('medium');
  // vertical context, horizontal context, note, URL, and the way back to the node
  for (const part of ['trip > hotel > book a room near the station', 'compare prices', 'two nights', 'https://example.com/hotels', dir, booking]) {
    expect(sent.body.description).toContain(part);
  }

  const doc = (await state()).doc;
  const node = doc.root.children[0].children[0];
  expect(node.tasks).toEqual([{ workspace: 'W1', project: 'p1', task: 't1' }]);
  expect(doc.dispatch).toEqual({ project: 'p1' });
});

test('a project that is not a kaneo id is refused before anything reaches kaneo', async () => {
  const before = seen.filter((s) => s.method === 'POST' && s.path.startsWith('/api/task/')).length;
  for (const project of ['--x', '', 'a/b', '?p1']) {
    expect((await person('POST', `/api/nodes/${booking}/kaneo-task`, { project })).status).toBe(400);
  }
  expect(seen.filter((s) => s.method === 'POST' && s.path.startsWith('/api/task/')).length).toBe(before);
});

test('a second create while one is out is refused, so a doubled click cannot make two tasks', async () => {
  const node = await spare('one task at a time');
  knobs.createMs = 300;
  try {
    const first = person('POST', `/api/nodes/${node}/kaneo-task`, { project: 'p1' });
    expect((await person('POST', `/api/nodes/${node}/kaneo-task`, { project: 'p1' })).status).toBe(409);
    expect((await first).status).toBe(200);
  } finally {
    knobs.createMs = 0;
  }
  expect((await state()).doc.root.children.find((n: any) => n.id === node).tasks).toHaveLength(1);
});

test('a node deleted while kaneo is answering takes the new task with it', async () => {
  const node = await spare('doomed');
  knobs.createMs = 200;
  let answer: Answer;
  try {
    const run = person('POST', `/api/nodes/${node}/kaneo-task`, { project: 'p1' });
    await Bun.sleep(50);
    expect((await person('DELETE', `/api/nodes/${node}`)).status).toBe(200);
    answer = await run;
  } finally {
    knobs.createMs = 0;
  }
  expect(answer.status).toBe(409);
  expect(answer.json.error).toContain('the task was deleted');
  // Nothing is left where the person cannot see it: kaneo has the task no more, and so has the map.
  expect(seen.filter((s) => s.method === 'DELETE' && s.path.startsWith('/api/task/'))).toHaveLength(1);
  expect([...tasks.values()].some((t) => t.title === 'doomed')).toBe(false);
  expect((await state()).doc.root.children.some((n: any) => n.id === node)).toBe(false);
});

test('the new task takes its status from kaneo\'s answer, without reading the map again', async () => {
  // A poll an hour away, so the only task read this map could do is one a create asked for.
  await withServer(
    config(command()),
    'K',
    async (call) => {
      const node = (await call('POST', '/api/nodes', { parentId: 'n1', text: 'from the answer' })).json.id as string;
      const { status, json } = await call('POST', `/api/nodes/${node}/kaneo-task`, { project: 'p2' });
      expect(status).toBe(200);
      // By the new task's id: the file's other server polls kaneo every 50 ms and shares `seen`.
      expect(seen.filter((s) => s.method === 'GET' && s.path === `/api/task/${json.task.id}`)).toHaveLength(0);
      expect(((await call('GET', '/api/state')).json as any).taskStatus[json.task.id]).toEqual({ status: 'to-do', number: json.task.number, title: 'from the answer' });
    },
    3_600_000,
  );
});

test('the status of linked tasks is read from kaneo and refreshed', async () => {
  expect((await state()).taskStatus['t1']).toMatchObject({ status: 'to-do', number: 41 });
  tasks.get('t1')!.status = 'in-progress';
  await Bun.sleep(300);
  expect((await state()).taskStatus['t1']).toMatchObject({ status: 'in-progress' });
});

test('a status change is what makes the browser redraw', async () => {
  const before = (await person('GET', '/api/rev')).json.rev;
  tasks.get('t2')!.status = 'done';
  await Bun.sleep(300);
  expect((await person('GET', '/api/rev')).json.rev).toBeGreaterThan(before);
  expect((await state()).taskStatus['t2']).toMatchObject({ status: 'done' });
});

test('dispatch runs the configured command with the task number, project and repo', async () => {
  const { status, json } = await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'TakashiAihara/eda' });
  expect(status).toBe(200);
  expect(json.code).toBe(0);
  expect(json.output).toContain('started');
  // A command that printed nothing on stderr has no stderr heading to read.
  expect(json.output).not.toContain('--- stderr ---');
  expect(readFileSync(argvFile, 'utf8')).toBe('41\n--project\np1\n--repo\nTakashiAihara/eda\n');
  expect((await state()).doc.dispatch).toEqual({ project: 'p1', repo: 'TakashiAihara/eda' });
});

test('the command is given the workspace and the task id too', async () => {
  const all = join(home, 'argv-all');
  tasks.set('t9', { id: 't9', number: 49, title: 'x', description: '', status: 'to-do', projectId: 'p1' });
  await withServer(config(['sh', '-c', `printf '%s\\n' "$@" > ${all}`, 'spawn', '{number}', '{workspace}', '{task}', '{project}']), 'K', async (call) => {
    await call('POST', `/api/nodes/n1/tasks`, { url: 'http://k/dashboard/workspace/W1/project/p1/task/t9' });
    expect((await call('POST', '/api/nodes/n1/tasks/t9/dispatch', { repo: 'o/r' })).status).toBe(200);
  });
  expect(readFileSync(all, 'utf8')).toBe('49\nW1\nt9\np1\n');
});

test('a second dispatch of the same task while one runs is refused', async () => {
  writeFileSync(argvFile, '');
  const first = person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'o/slow' });
  const { status, json } = await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'o/slow' });
  expect(status).toBe(409);
  expect(json.error).toContain('already dispatching');
  expect((await first).status).toBe(200);
  // One run, not two: the command writes its argv once, from the one that was let through.
  expect(readFileSync(argvFile, 'utf8')).toBe('41\n--project\np1\n--repo\no/slow\n');
});

test('the project the command is given is kaneo\'s, not the one the link names', async () => {
  const node = await spare('moved between projects');
  tasks.set('tmoved', { id: 'tmoved', number: 77, title: 'moved', description: '', status: 'to-do', projectId: 'p1' });
  await link(node, 'tmoved', 'other');
  writeFileSync(argvFile, '');
  expect((await person('POST', `/api/nodes/${node}/tasks/tmoved/dispatch`, { repo: 'o/r' })).status).toBe(200);
  expect(readFileSync(argvFile, 'utf8')).toContain('--project\np1\n');

  // A task kaneo cannot place is refused rather than run with a guess.
  tasks.set('tnowhere', { id: 'tnowhere', number: 78, title: 'nowhere', description: '', status: 'to-do' });
  await link(node, 'tnowhere');
  expect((await person('POST', `/api/nodes/${node}/tasks/tnowhere/dispatch`, { repo: 'o/r' })).status).toBe(502);
});

test('dispatch refuses a repo that is not owner/name, so nothing else reaches argv', async () => {
  writeFileSync(argvFile, '');
  for (const repo of ['eda', 'a/b; rm -rf /', '--force/x', 'a/b/c', '../..', './.', 'a/..', 'a/.']) {
    expect((await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo })).status).toBe(400);
  }
  expect(readFileSync(argvFile, 'utf8')).toBe('');
});

test('dispatch of a task not linked to the node is refused', async () => {
  expect((await person('POST', `/api/nodes/${hotel}/tasks/t1/dispatch`, { repo: 'o/r' })).status).toBe(404);
});

test('a failing command is reported with its exit code, not as success', async () => {
  const { status, json } = await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'o/fail' });
  expect(status).toBe(502);
  expect(json.code).toBe(3);
  expect(json.output).toContain('boom');
});

test('what the command printed is the tail of each stream, stderr under its own heading', async () => {
  const { status, json } = await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'o/loud' });
  expect(status).toBe(200);
  const [out, err] = json.output.split('\n--- stderr ---\n') as [string, string];
  // 4000 characters of each, kept as they arrive rather than read whole: enough to see why it
  // failed, not the whole scrollback, and neither stream swallowed by the other.
  expect(out).toHaveLength(4000);
  expect(out.endsWith('\nstarted\n')).toBe(true);
  expect(err).toBe('trouble\n');
});

test('a command past the ceiling is killed and reported as a timeout', async () => {
  // The ceiling is 300 s; this rewrites that one delay, so the wait is a moment's instead.
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number, ...rest: unknown[]) => real(fn, ms === 300_000 ? 30 : ms, ...(rest as []))) as typeof setTimeout;
  try {
    const { status, json } = await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'o/hang' });
    expect(status).toBe(504);
    expect(json.code).toBeNull();
    expect(json.timedOut).toBe(true);
    expect(typeof json.output).toBe('string');
  } finally {
    globalThis.setTimeout = real;
  }
});

test('a command that cannot be started at all leaves the map as it was', async () => {
  tasks.set('t9', { id: 't9', number: 49, title: 'x', description: '', status: 'to-do', projectId: 'p1' });
  await withServer(config(['/nonexistent/eda-command', '{number}']), 'K', async (call) => {
    await call('POST', `/api/nodes/n1/tasks`, { url: 'http://k/dashboard/workspace/W1/project/p1/task/t9' });
    expect((await call('POST', '/api/nodes/n1/tasks/t9/dispatch', { repo: 'o/never' })).status).toBe(500);
    expect(((await call('GET', '/api/state')).json as any).doc.dispatch).toBeUndefined();
  });
});

test('a kaneo that dies mid-answer is a refusal, not a thrown error', async () => {
  const node = await spare('cut off');
  const task = (await person('POST', `/api/nodes/${node}/kaneo-task`, { project: 'p1' })).json.task as FakeTask;
  knobs.cut = task.id;
  try {
    // The pass writes down what it could not read and carries on with the rest.
    await Bun.sleep(300);
    expect((await state()).taskStatus[task.id]).toEqual({ status: 'unknown' });
    // A route that waits on kaneo says so with kaneo's own words, not as a 500.
    const { status, json } = await person('POST', `/api/nodes/${node}/tasks/${task.id}/dispatch`, { repo: 'o/r' });
    expect(status).toBe(502);
    expect(json.error).toContain(`kaneo /task/${task.id}:`);
  } finally {
    knobs.cut = null;
  }
});

test('a task kaneo no longer returns shows as unknown and stays linked', async () => {
  tasks.delete('t1');
  await Bun.sleep(300);
  const s = await state();
  expect(s.taskStatus['t1']).toMatchObject({ status: 'unknown' });
  expect(s.doc.root.children[0].children[0].tasks).toHaveLength(1);
});

test('a slow kaneo does not make the passes pile up on each other', async () => {
  knobs.getMs = 200;
  knobs.maxInFlight = 0;
  try {
    // Twenty ticks go by inside one pass: without a guard they would overlap, and an older pass
    // would write a stale status over the newer one.
    await Bun.sleep(1000);
  } finally {
    knobs.getMs = 0;
  }
  expect(knobs.maxInFlight).toBe(1);
});

test('without KANEO_API_KEY the create, dispatch and status features are off, and their routes refuse', async () => {
  await withServer(config(command()), null, async (call) => {
    const st = (await call('GET', '/api/state')).json as any;
    expect(st.kaneo).toEqual({ host: kaneoUrl, status: false, createTask: false, dispatch: false });
    expect((await call('GET', '/api/kaneo/projects')).status).toBe(400);
    expect((await call('POST', '/api/nodes/n1/kaneo-task', { project: 'p1' })).status).toBe(400);
    // Linked first, so the dispatch route gets as far as the switch and refuses on it.
    await call('POST', `/api/nodes/n1/tasks`, { url: 'http://k/dashboard/workspace/W1/project/p1/task/t9' });
    expect((await call('POST', '/api/nodes/n1/tasks/t9/dispatch', { repo: 'o/r' })).status).toBe(400);
  });
});

test('host and the key are enough to read a task; creating one also needs a workspace', async () => {
  await withServer({ kaneo: { host: kaneoUrl }, spawn: { command: command() } }, 'K', async (call) => {
    const st = (await call('GET', '/api/state')).json as any;
    expect(st.kaneo).toEqual({ host: kaneoUrl, status: true, createTask: false, dispatch: true });
    // The picker has no workspace to look in, so it refuses rather than asking every one of them.
    expect((await call('GET', '/api/kaneo/projects')).status).toBe(400);
    expect((await call('POST', '/api/nodes/n1/kaneo-task', { project: 'p1' })).status).toBe(400);
  });
});

test('a config with no spawn.command leaves dispatch off, and its route says so', async () => {
  await withServer({ kaneo: { host: kaneoUrl, workspace: 'W1' } }, 'K', async (call) => {
    const st = (await call('GET', '/api/state')).json as any;
    expect(st.kaneo).toEqual({ host: kaneoUrl, status: true, createTask: true, dispatch: false });
    await call('POST', `/api/nodes/n1/tasks`, { url: 'http://k/dashboard/workspace/W1/project/p1/task/t9' });
    expect((await call('POST', '/api/nodes/n1/tasks/t9/dispatch', { repo: 'o/r' })).status).toBe(400);
  });
});

test('a spawn.command that is not an argv array turns dispatch off, and says so at start', async () => {
  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => said.push(args.map(String).join(' '));
  try {
    await withServer(config('spawn-task 41 --project p1'), 'K', async (call) => {
      expect(((await call('GET', '/api/state')).json as any).kaneo.dispatch).toBe(false);
      await call('POST', `/api/nodes/n1/tasks`, { url: 'http://k/dashboard/workspace/W1/project/p1/task/t9' });
      // Refused at the click, rather than a 500 from taking a string's length for an argv.
      expect((await call('POST', '/api/nodes/n1/tasks/t9/dispatch', { repo: 'o/r' })).status).toBe(400);
    });
  } finally {
    console.error = realError;
  }
  expect(said.join('\n')).toContain('spawn.command');
});

test('mcp.ts offers no tool for the kaneo routes', async () => {
  const { readFileSync: read } = await import('node:fs');
  const mcp = read(join(import.meta.dir, '..', 'src', 'mcp.ts'), 'utf8');
  expect(mcp).not.toContain('kaneo-task');
  expect(mcp).not.toContain('dispatch');
});

test('a map.md edit saved while dispatch runs is offered, not exported over', async () => {
  tasks.set('t9', { id: 't9', number: 49, title: 'x', description: '', status: 'to-do', projectId: 'p1' });
  await person('POST', `/api/nodes/${hotel}/tasks`, { url: 'http://k/dashboard/workspace/W1/project/p1/task/t9' });
  const md = readFileSync(join(dir, 'map.md'), 'utf8');
  const run = person('POST', `/api/nodes/${hotel}/tasks/t9/dispatch`, { repo: 'o/slow' });
  await Bun.sleep(150);
  writeFileSync(join(dir, 'map.md'), `${md}- flights\n`);
  expect((await run).status).toBe(200);
  const s = await state();
  expect(s.doc.suggestions.map((x: any) => [x.source.by, x.text])).toContainEqual(['md-edit', 'flights']);
});

test('a task the person unlinks stops being polled and leaves the statuses', async () => {
  expect((await state()).taskStatus['t9']).toMatchObject({ status: 'to-do' });
  expect((await person('DELETE', `/api/nodes/${hotel}/tasks`, { task: 't9' })).status).toBe(200);
  await Bun.sleep(300);
  expect((await state()).taskStatus['t9']).toBeUndefined();
  // Unlinked is eda's business: kaneo still has the task, and eda did not delete it.
  expect(tasks.has('t9')).toBe(true);
});
