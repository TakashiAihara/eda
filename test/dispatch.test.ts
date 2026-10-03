/**
 * Node → kaneo task → session (docs/design/0003-node-to-session.md), against a fake kaneo
 * and a fake spawn command that records its argv.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'eda-dispatch-'));
const argvFile = join(home, 'argv');

type FakeTask = { id: string; number: number; title: string; description: string; status: string; projectId: string };
const tasks = new Map<string, FakeTask>();
const seen: { method: string; path: string; auth: string | null; body: any }[] = [];
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
    const create = /^\/api\/task\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'POST' && create) {
      const t: FakeTask = { id: `t${tasks.size + 1}`, number: 40 + tasks.size + 1, title: body.title, description: body.description, status: body.status, projectId: create[1]! };
      tasks.set(t.id, t);
      return Response.json(t);
    }
    if (req.method === 'GET' && create && tasks.has(create[1]!)) return Response.json(tasks.get(create[1]!));
    return Response.json({ message: 'not found' }, { status: 404 });
  },
});

mkdirSync(join(home, 'eda'), { recursive: true });
writeFileSync(
  join(home, 'eda', 'config.json'),
  JSON.stringify({
    kaneo: { host: `http://127.0.0.1:${kaneo.port}`, workspace: 'W1' },
    spawn: { command: ['sh', '-c', `printf '%s\\n' "$@" > ${argvFile}; if [ "$5" = o/fail ]; then echo boom; exit 3; fi; if [ "$5" = o/slow ]; then sleep 0.5; fi; echo started`, 'spawn', '{number}', '--project', '{project}', '--repo', '{repo}'] },
  }),
);
process.env['EDA_HOME'] = home;
process.env['XDG_CONFIG_HOME'] = home;
delete process.env['EDA_KANEO_HOST'];
process.env['KANEO_API_KEY'] = 'K';

const { startServer } = await import('../src/server.ts');
const { token } = await import('../src/store.ts');

const dir = mkdtempSync(join(tmpdir(), 'eda-map-'));
const { server } = startServer({ dir, host: '127.0.0.1', port: 0, title: 'trip', kaneoPollMs: 50 });
afterAll(() => {
  server.stop(true);
  kaneo.stop(true);
});

const base = `http://127.0.0.1:${server.port}`;
const person = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as any };
};
const state = async () => (await person('GET', '/api/state')).json;

const hotel = (await person('POST', '/api/nodes', { parentId: 'n1', text: 'hotel' })).json.id as string;
const booking = (await person('POST', '/api/nodes', { parentId: hotel, text: 'book a room near the station' })).json.id as string;
await person('POST', '/api/nodes', { parentId: hotel, text: 'compare prices' });
await person('PATCH', `/api/nodes/${booking}`, { note: 'two nights' });
await person('POST', `/api/nodes/${booking}/urls`, { url: 'https://example.com/hotels' });

test('the state says which kaneo features are available', async () => {
  expect((await state()).kaneo).toEqual({ host: `http://127.0.0.1:${kaneo.port}`, createTask: true, dispatch: true });
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

test('the status of linked tasks is read from kaneo and refreshed', async () => {
  expect((await state()).taskStatus['t1']).toMatchObject({ status: 'to-do', number: 41 });
  tasks.get('t1')!.status = 'in-progress';
  await Bun.sleep(300);
  expect((await state()).taskStatus['t1']).toMatchObject({ status: 'in-progress' });
});

test('dispatch runs the configured command with the task number, project and repo', async () => {
  const { status, json } = await person('POST', `/api/nodes/${booking}/tasks/t1/dispatch`, { repo: 'TakashiAihara/eda' });
  expect(status).toBe(200);
  expect(json.code).toBe(0);
  expect(json.output).toContain('started');
  expect(readFileSync(argvFile, 'utf8')).toBe('41\n--project\np1\n--repo\nTakashiAihara/eda\n');
  expect((await state()).doc.dispatch).toEqual({ project: 'p1', repo: 'TakashiAihara/eda' });
});

test('dispatch refuses a repo that is not owner/name, so nothing else reaches argv', async () => {
  writeFileSync(argvFile, '');
  for (const repo of ['eda', 'a/b; rm -rf /', '--force/x', 'a/b/c']) {
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

test('a task kaneo no longer returns shows as unknown and stays linked', async () => {
  tasks.delete('t1');
  await Bun.sleep(300);
  const s = await state();
  expect(s.taskStatus['t1']).toMatchObject({ status: 'unknown' });
  expect(s.doc.root.children[0].children[0].tasks).toHaveLength(1);
});

test('without KANEO_API_KEY the create and dispatch features are off, and their routes refuse', async () => {
  delete process.env['KANEO_API_KEY'];
  const d2 = mkdtempSync(join(tmpdir(), 'eda-map-'));
  const { server: s2 } = startServer({ dir: d2, host: '127.0.0.1', port: 0, title: 'x' });
  try {
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${s2.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const st = (await (await call('GET', '/api/state')).json()) as any;
    expect(st.kaneo).toEqual({ host: `http://127.0.0.1:${kaneo.port}`, createTask: false, dispatch: false });
    expect((await call('POST', '/api/nodes/n1/kaneo-task', { project: 'p1' })).status).toBe(400);
  } finally {
    s2.stop(true);
    process.env['KANEO_API_KEY'] = 'K';
  }
});

test('the AI side has no route to create or dispatch tasks', async () => {
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
