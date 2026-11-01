import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const made: string[] = [];
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
// Registered before anything below can throw, so a failed import still leaves nothing behind.
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const home = temp('eda-home-');
process.env['EDA_HOME'] = home;
// Never the real ~/.config/eda: a kaneo host there would change what the tests see.
process.env['XDG_CONFIG_HOME'] = home;
const { startServer } = await import('../src/server.ts');
const { Client, describe: describeChat, runTool, undelivered } = await import('../src/mcp.ts');
const { aiToken, loadMap, token } = await import('../src/store.ts');
const { toMarkdown } = await import('../src/map.ts');

const dir = temp('eda-map-');
const { server, stop } = startServer({ dir, host: '127.0.0.1', port: 0, title: 'trip', session: 'S1', cwd: '/w' });
afterAll(() => stop());

const base = `http://127.0.0.1:${server.port}`;
const person = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as any };
};
const claude = new Client('S1', '/w', () => [{ pid: 1, dir, host: '127.0.0.1', port: server.port!, startedAt: '' }]);

test('the API refuses requests without the token', async () => {
  expect((await fetch(`${base}/api/state`)).status).toBe(401);
  const w = await fetch(`${base}/api/nodes`, { method: 'POST', body: JSON.stringify({ parentId: 'n1', text: 'x' }) });
  expect(w.status).toBe(401);
});

test('the page is served', async () => {
  const r = await fetch(`${base}/`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('<aside>');
});

test('Claude reads, suggests three nodes, is refused a fourth, and the person adopts', async () => {
  expect(await runTool(claude, 'read_map', {})).toContain('- [n1] trip');
  expect(await runTool(claude, 'suggest_node', { parent_id: 'n1', text: 'where to stay', reason: 'r' })).toMatch(/waiting/);
  await runTool(claude, 'suggest_node', { parent_id: 'n1', text: 'budget', reason: 'r' });
  await runTool(claude, 'suggest_node', { parent_id: 'n1', text: 'dates', reason: 'r' });
  await expect(runTool(claude, 'suggest_node', { parent_id: 'n1', text: 'food', reason: 'r' })).rejects.toThrow(/at most 3 at a time/);

  const { json } = await person('GET', '/api/state');
  expect(json.doc.root.children).toHaveLength(0);
  expect(json.doc.suggestions.map((s: any) => s.text)).toEqual(['where to stay', 'budget', 'dates']);
  const id = json.doc.suggestions[0].id;
  await person('POST', `/api/suggestions/${id}/accept`, { text: 'hotel' });
  const after = (await person('GET', '/api/state')).json.doc;
  expect(after.root.children[0].text).toBe('hotel');
  expect(after.root.children[0].origin).toEqual({ by: 'ai', session: 'S1' });
  expect(readFileSync(join(dir, 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n');
  // later tests expect no suggestion left waiting
  for (const s of after.suggestions) await person('POST', `/api/suggestions/${s.id}/reject`);
  expect((await person('GET', '/api/state')).json.doc.suggestions).toHaveLength(0);
});

test('the session that started the map is recorded for resume', async () => {
  const { json } = await person('GET', '/api/state');
  expect(json.doc.sessions.map((s: any) => s.id)).toEqual(['S1']);
});

test('a hand edit of map.md is not read: the map and the candidate list stay, and the next save exports over it', async () => {
  const d = temp('eda-md-');
  const { server: s, stop: stopIt } = startServer({ dir: d, host: '127.0.0.1', port: 0, title: 'trip' });
  try {
    const call = async (method: string, path: string, body?: unknown) =>
      (await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<any>;
    await call('POST', '/api/nodes', { parentId: 'n1', text: 'hotel' });
    const before = (await call('GET', '/api/state')).doc;
    writeFileSync(join(d, 'map.md'), '# trip\n\n- hotel\n- flights\n');
    const after = (await call('GET', '/api/state')).doc;
    expect(after.root).toEqual(before.root);
    expect(after.root.children.map((c: any) => c.text)).toEqual(['hotel']);
    expect(after.suggestions).toEqual([]);
    expect(readFileSync(join(d, 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n- flights\n');
    await call('POST', '/api/chat', { text: 'saved' });
    expect(readFileSync(join(d, 'map.md'), 'utf8')).toBe(toMarkdown(after.root));
    // Nor read on the write: the save exported over the edit without taking anything from it.
    const saved = (await call('GET', '/api/state')).doc;
    expect(saved.root).toEqual(before.root);
    expect(saved.suggestions).toEqual([]);
  } finally {
    stopIt();
  }
});

test('starting on an existing map writes map.md again, from eda.json', async () => {
  const d = temp('eda-md-');
  const first = startServer({ dir: d, host: '127.0.0.1', port: 0, title: 'trip' });
  first.stop();
  // A child written into eda.json only, as a save cut short between the two files leaves it.
  const { addChild } = await import('../src/map.ts');
  const { saveMap } = await import('../src/store.ts');
  const doc = loadMap(d)!;
  addChild(doc, addChild(doc, 'n1', 'hotel').id, 'booking');
  saveMap(d, doc);
  const json = readFileSync(join(d, 'eda.json'), 'utf8');
  writeFileSync(join(d, 'map.md'), '# stale\n');
  const again = startServer({ dir: d, host: '127.0.0.1', port: 0 });
  again.stop();
  expect(readFileSync(join(d, 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n  - booking\n');
  expect(readFileSync(join(d, 'eda.json'), 'utf8')).toBe(json);
});

test('a symlinked map.md and eda.json are written through, and keep the mode of the files they point at', async () => {
  const { lstatSync, statSync, symlinkSync, chmodSync, renameSync } = await import('node:fs');
  const { saveMap } = await import('../src/store.ts');
  const { addChild } = await import('../src/map.ts');
  const d = temp('eda-link-');
  const vault = temp('eda-vault-');
  const first = startServer({ dir: d, host: '127.0.0.1', port: 0, title: 'trip' });
  first.stop();
  // Both files moved into another directory and linked back, as a vault-kept map would be: one
  // link absolute, one relative. 0606 keeps other-write, which the usual umasks (022 / 002 / 027)
  // take off, so it survives only if the mode is set whole after the write.
  for (const f of ['map.md', 'eda.json']) {
    renameSync(join(d, f), join(vault, f));
    chmodSync(join(vault, f), 0o606);
  }
  symlinkSync(join(vault, 'map.md'), join(d, 'map.md'));
  symlinkSync(join('..', basename(vault), 'eda.json'), join(d, 'eda.json'));
  const doc = loadMap(d)!;
  addChild(doc, 'n1', 'hotel');
  saveMap(d, doc);
  for (const f of ['map.md', 'eda.json']) {
    expect([f, lstatSync(join(d, f)).isSymbolicLink()]).toEqual([f, true]);
    expect([f, statSync(join(vault, f)).mode & 0o777]).toEqual([f, 0o606]);
  }
  expect(readFileSync(join(vault, 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n');
  expect(loadMap(vault)!.root.children.map((c) => c.text)).toEqual(['hotel']);
  // Nothing half-written left beside the files.
  expect(readdirSync(vault).sort()).toEqual(['eda.json', 'map.md']);
});

test('a map whose linked files are not there is refused at start, and its links are left as they were', async () => {
  const { lstatSync, readlinkSync, symlinkSync } = await import('node:fs');
  const d = temp('eda-dangling-');
  const gone = join(temp('eda-unmounted-'), 'not-here');
  symlinkSync(join(gone, 'eda.json'), join(d, 'eda.json'));
  symlinkSync(join(gone, 'map.md'), join(d, 'map.md'));
  expect(() => startServer({ dir: d, host: '127.0.0.1', port: 0 })).toThrow(`${join(d, 'eda.json')} is a symlink to nothing`);
  expect(lstatSync(join(d, 'eda.json')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(d, 'map.md'))).toBe(join(gone, 'map.md'));
  // map.md alone dangling, with eda.json there: still refused, not written over.
  const d2 = temp('eda-dangling-md-');
  startServer({ dir: d2, host: '127.0.0.1', port: 0, title: 't' }).stop();
  rmSync(join(d2, 'map.md'));
  symlinkSync(join(gone, 'map.md'), join(d2, 'map.md'));
  expect(() => startServer({ dir: d2, host: '127.0.0.1', port: 0 })).toThrow(`${join(d2, 'map.md')} is a symlink to nothing; mount or fix what it points at, or remove the link`);
  expect(readlinkSync(join(d2, 'map.md'))).toBe(join(gone, 'map.md'));
});

test('a map.md that is not a regular file is not replaced', async () => {
  const { lstatSync } = await import('node:fs');
  const d = temp('eda-fifo-');
  startServer({ dir: d, host: '127.0.0.1', port: 0, title: 't' }).stop();
  rmSync(join(d, 'map.md'));
  Bun.spawnSync(['mkfifo', join(d, 'map.md')]);
  expect(lstatSync(join(d, 'map.md')).isFIFO()).toBe(true);
  expect(() => startServer({ dir: d, host: '127.0.0.1', port: 0 })).toThrow(`${join(d, 'map.md')} is not a regular file`);
  expect(lstatSync(join(d, 'map.md')).isFIFO()).toBe(true);
});

test('a save refused for map.md leaves eda.json as it was', async () => {
  const { symlinkSync } = await import('node:fs');
  const d = temp('eda-half-');
  const s = startServer({ dir: d, host: '127.0.0.1', port: 0, title: 't' });
  try {
    const json = readFileSync(join(d, 'eda.json'), 'utf8');
    // The vault map.md lived in goes away while the map is open.
    rmSync(join(d, 'map.md'));
    symlinkSync(join(temp('eda-unmounted-'), 'gone', 'map.md'), join(d, 'map.md'));
    const r = await fetch(`http://127.0.0.1:${s.server.port}/api/nodes`, { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ parentId: 'n1', text: 'lost?' }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(`${join(d, 'map.md')} is a symlink to nothing; mount or fix what it points at, or remove the link`);
    expect(readFileSync(join(d, 'eda.json'), 'utf8')).toBe(json);
  } finally {
    s.stop();
  }
});

test('a dangling eda.json beside a map.md is reported as the dangling link, not as a stray map.md', async () => {
  const { symlinkSync } = await import('node:fs');
  const d = temp('eda-dangling-json-');
  writeFileSync(join(d, 'map.md'), '# kept\n');
  symlinkSync(join(temp('eda-unmounted-'), 'gone', 'eda.json'), join(d, 'eda.json'));
  expect(() => startServer({ dir: d, host: '127.0.0.1', port: 0 })).toThrow(`${join(d, 'eda.json')} is a symlink to nothing`);
  expect(readFileSync(join(d, 'map.md'), 'utf8')).toBe('# kept\n');
});

test('the running-map record is written in place of a symlink there, not through it', async () => {
  const { lstatSync, mkdirSync, symlinkSync } = await import('node:fs');
  const { registerInstance } = await import('../src/store.ts');
  const victim = join(temp('eda-victim-'), 'victim.txt');
  writeFileSync(victim, 'keep me\n');
  mkdirSync(join(home, 'instances'), { recursive: true });
  // A pid no test registers.
  const pid = 999_999_001;
  symlinkSync(victim, join(home, 'instances', `${pid}.json`));
  const unregister = registerInstance({ pid, dir: '/x', host: '127.0.0.1', port: 1, startedAt: '' });
  try {
    expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
    expect(lstatSync(join(home, 'instances', `${pid}.json`)).isSymbolicLink()).toBe(false);
  } finally {
    unregister();
  }
});

test('a directory with a map.md but no eda.json is refused, and the map.md is left as it was', () => {
  const d = temp('eda-md-');
  writeFileSync(join(d, 'map.md'), '# ideas\n\n- one\n');
  expect(() => startServer({ dir: d, host: '127.0.0.1', port: 0 })).toThrow(/map\.md exists but eda\.json does not/);
  expect(readFileSync(join(d, 'map.md'), 'utf8')).toBe('# ideas\n\n- one\n');
  expect(existsSync(join(d, 'eda.json'))).toBe(false);
});

test('eda serve on a directory with only a map.md exits 1 with one line and leaves no lock behind', async () => {
  const d = temp('eda-md-');
  writeFileSync(join(d, 'map.md'), '# ideas\n');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), EDA_HOME: home, XDG_CONFIG_HOME: home };
  delete env['CLAUDE_CODE_SESSION_ID'];
  const p = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'serve', d, '--host', '127.0.0.1'], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect(code).toBe(1);
  expect(err.trim().split('\n')).toEqual([`eda: ${join(d, 'map.md')} exists but eda.json does not; move map.md away or pick another directory`]);
  expect(existsSync(join(d, 'eda.lock'))).toBe(false);
  expect(existsSync(join(d, 'eda.json'))).toBe(false);
});

test('chat from the person is visible to Claude, and Claude replies without touching the map', async () => {
  const before = JSON.stringify((await person('GET', '/api/state')).json.doc.root);
  await person('POST', '/api/chat', { text: 'what about budget?', nodeId: 'n1' });
  expect(await runTool(claude, 'reply', { text: 'set a ceiling first' })).toBe('posted');
  const doc = (await person('GET', '/api/state')).json.doc;
  // The system lines before these are the decisions on the earlier suggestions.
  expect(doc.chat.filter((c: any) => c.from !== 'system').map((c: any) => [c.from, c.text])).toEqual([
    ['human', 'what about budget?'],
    ['ai', 'set a ceiling first'],
  ]);
  expect(JSON.stringify(doc.root)).toBe(before);
});

test('asking whether a map is ours does not make it ours; naming it does', async () => {
  const registry = () => [{ pid: 1, dir, host: '127.0.0.1', port: server.port!, startedAt: '' }];
  const other = new Client('S2', '/x', registry);
  await expect(runTool(other, 'read_map', {})).rejects.toThrow(/no running map/);
  await expect(runTool(other, 'read_map', {})).rejects.toThrow(/no running map/);
  await runTool(other, 'read_map', { map: `${dir}/` });
  expect(await runTool(other, 'read_map', {})).toContain('[n1] trip');
});

test('the channel resumes after what was delivered, or from when the session joined', () => {
  const doc: any = {
    sessions: [
      { id: 'A', cwd: '', at: '2026-01-02' },
      { id: 'B', cwd: '', at: '2026-01-01', delivered: 2 },
    ],
    chat: [
      { id: 'c1', at: '2026-01-01', from: 'human', text: 'before A joined' },
      { id: 'c2', at: '2026-01-03', from: 'human', text: 'delivered to B' },
      { id: 'c3', at: '2026-01-03', from: 'ai', session: 'B', text: 'B answered c2' },
      { id: 'c4', at: '2026-01-03', from: 'human', text: 'arrived while B was restarting' },
    ],
  };
  expect(undelivered(doc, 'A').map((c) => c.id)).toEqual(['c2', 'c4']);
  // a decision on B's suggestion goes to B only
  doc.chat.push({ id: 'c5', at: '2026-01-04', from: 'system', session: 'B', text: 's1 採用' });
  expect(undelivered(doc, 'A', 4).map((c) => c.id)).toEqual([]);
  expect(undelivered(doc, 'B', 4).map((c) => c.id)).toEqual(['c5']);
  expect(undelivered(doc, 'B').map((c) => c.id)).toEqual(['c4', 'c5']);
  expect(undelivered(doc, 'A', 2).map((c) => c.id)).toEqual(['c4']);
});

test('the delivered position is stored per session on the map', async () => {
  await person('POST', '/api/chat', { text: 'ping' });
  const last = (await person('GET', '/api/state')).json.doc.chat.at(-1).id;
  await claude.call({ dir, base }, '/api/ai/delivered', { method: 'POST', body: JSON.stringify({ chatId: last }) });
  const onDisk = JSON.parse(readFileSync(join(dir, 'eda.json'), 'utf8'));
  const s1 = onDisk.sessions.find((s: any) => s.id === 'S1');
  expect(s1.delivered).toBe(Number(last.slice(1)));
});

test('a non-object JSON body is read as empty (no node named), not a 500', async () => {
  const r = await fetch(`${base}/api/nodes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: 'null',
  });
  expect(r.status).toBe(404);
});

test('the two tokens are different and each opens only its own routes', async () => {
  expect(aiToken()).not.toBe(token());
  const call = (path: string, secret: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-eda-session': 'S1' }, ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  // The person's token reaches none of the AI routes, so the browser side cannot speak as the AI.
  // With the AI's, each answers as it does for an empty body: past the auth, into the handler.
  for (const [path, method, past] of [['/api/ai/map', 'GET', 200], ['/api/ai/rev', 'GET', 200], ['/api/ai/state', 'GET', 200], ['/api/ai/suggest', 'POST', 404], ['/api/ai/reply', 'POST', 400], ['/api/ai/delivered', 'POST', 200]] as const) {
    expect([path, (await call(path, token(), method, {})).status]).toEqual([path, 401]);
    expect([path, (await call(path, aiToken(), method, {})).status]).toEqual([path, past]);
  }
  expect((await call('/api/rev', token())).status).toBe(200);
  expect((await call('/api/state', token())).status).toBe(200);
  // The AI's token reaches none of the person's: no adopting, deleting, editing, linking,
  // dispatching or reading the UI state. Every person route is listed.
  const s = (await (await call('/api/ai/suggest', aiToken(), 'POST', { kind: 'add', parentId: 'n1', text: 'by token', reason: '' })).json()) as { id: string };
  const personRoutes = [
    ['/api/state', 'GET'], ['/api/rev', 'GET'], ['/api/nodes', 'POST'], ['/api/nodes/n1', 'PATCH'], ['/api/nodes/n1', 'DELETE'],
    ['/api/nodes/n1/urls', 'POST'], ['/api/nodes/n1/urls', 'DELETE'], ['/api/nodes/n1/markers', 'POST'], ['/api/nodes/n1/tasks', 'POST'], ['/api/nodes/n1/tasks', 'DELETE'],
    ['/api/kaneo/projects', 'GET'], ['/api/nodes/n1/kaneo-task', 'POST'], ['/api/nodes/n1/tasks/t1/dispatch', 'POST'],
    [`/api/suggestions/${s.id}/accept`, 'POST'], [`/api/suggestions/${s.id}/reject`, 'POST'], ['/api/chat', 'POST'],
  ] as const;
  for (const [path, method] of personRoutes) {
    expect([path, method, (await call(path, aiToken(), method, {})).status]).toEqual([path, method, 401]);
  }
  expect((await person('GET', '/api/state')).json.doc.suggestions.some((x: any) => x.id === s.id)).toBe(true);
  await person('POST', `/api/suggestions/${s.id}/reject`, {});
});

test('a map that does not take the session token is named, not reported as no map at all', async () => {
  const hint = 'An eda serve started before the AI got its own token, or before ai-token was replaced, does that: restart it.';
  // As an eda serve from before the split answers /api/ai/rev: no such route, Bun's plain 404.
  // (Its /api/ai/map, suggest and reply exist and answer 401, as the wrong-token client below gets.)
  const old = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('not found', { status: 404 }) });
  // Nothing listening: a map that went down, which is not the same answer.
  const down = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const downPort = down.port!;
  down.stop(true);
  try {
    const at = (d: string, port: number) => ({ pid: 1, dir: d, host: '127.0.0.1', port, startedAt: '' });
    // A token this server does not know: its 401.
    const wrong = new Client('S1', '/w', () => [at(dir, server.port!)], () => 'stale-token');
    await expect(runTool(wrong, 'read_map', {})).rejects.toThrow(`no running map for this session; these do not take its calls: ${dir}. ${hint}`);
    await expect(runTool(wrong, 'read_map', { map: dir })).rejects.toThrow(`the map at ${dir} does not take this session's calls. ${hint}`);
    const pre = new Client('S1', '/w', () => [at('/old-map', old.port!), at('/down-map', downPort)]);
    await expect(runTool(pre, 'read_map', {})).rejects.toThrow(`no running map for this session; these do not take its calls: /old-map. ${hint}`);
    // A map named that is not running is just that, whatever the look before found.
    await expect(runTool(wrong, 'read_map', { map: '/nowhere' })).rejects.toThrow(/^no running map at \/nowhere$/);
    // A map that is just not this session's, or down, is still the plain answer.
    await expect(runTool(new Client('S-nobody', '/w', () => [at(dir, server.port!), at('/down-map', downPort)]), 'read_map', {})).rejects.toThrow(/^no running map for this session\. Start one/);
    // eda's own 404 (a JSON error from a handler) is not a missing route.
    const own = await runTool(claude, 'suggest_edit', { node_id: 'n-none', text: 'x', reason: '' }).catch((e: Error) => e.message);
    expect(own).toBe('no node n-none');
  } finally {
    old.stop(true);
  }
});

test('an AI call without a session is refused', async () => {
  const r = await fetch(`${base}/api/ai/suggest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aiToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'add', parentId: 'n1', text: 'x', reason: '' }),
  });
  expect(r.status).toBe(400);
});

test('clearing the text box on an edit keeps the node text', async () => {
  await runTool(claude, 'suggest_edit', { node_id: 'n1', text: 'renamed', urls: ['https://e.example/'], reason: 'r' });
  const s = (await person('GET', '/api/state')).json.doc.suggestions.find((x: any) => x.source.by === 'ai');
  await person('POST', `/api/suggestions/${s.id}/accept`, { text: null, urls: s.urls });
  const doc = (await person('GET', '/api/state')).json.doc;
  expect(doc.root.text).toBe('trip');
  expect(doc.root.urls.map((u: any) => u.url)).toEqual(['https://e.example/']);
});

test('a channel event carries the message and the node it is about', () => {
  const doc: any = { root: { id: 'n1', text: 'trip', children: [{ id: 'n2', text: 'hotel', children: [] }] } };
  const e = describeChat('/m', { id: 'c7', at: '', from: 'human', nodeId: 'n2', text: 'cheaper?' }, doc);
  expect(e.content).toBe('cheaper?\n\nAbout node n2: hotel');
  expect(e.meta).toEqual({ map: '/m', chat_id: 'c7', kind: 'message', node_id: 'n2' });
});

test('registry records are only contacted on this host, on a numeric port', async () => {
  const { localBase } = await import('../src/mcp.ts');
  expect(localBase('0.0.0.0', 4000)).toBe('http://127.0.0.1:4000');
  expect(localBase('127.0.0.1', '1@evil.example')).toBeUndefined();
  expect(localBase('127.0.0.1', 70000)).toBeUndefined();
  expect(localBase('203.0.113.9', 4000)).toBeUndefined();
});

test('eda mcp pushes the person\'s chat into the session as a channel event', async () => {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new McpClient({ name: 't', version: '0' });
  const got: any[] = [];
  c.fallbackNotificationHandler = async (n) => {
    got.push(n);
  };
  // The server under test is registered like a real `eda serve`.
  const { registerInstance } = await import('../src/store.ts');
  const unregister = registerInstance({ pid: process.pid, dir, host: '127.0.0.1', port: server.port!, session: 'S1', startedAt: '' });
  try {
    await c.connect(
      new StdioClientTransport({
        command: 'bun',
        args: [join(import.meta.dir, '../src/cli.ts'), 'mcp'],
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'S1' } as Record<string, string>,
      }),
    );
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['read_map', 'suggest_node', 'suggest_edit', 'reply']);
    await Bun.sleep(2500);
    await person('POST', '/api/chat', { text: 'over the channel', nodeId: 'n1' });
    // Earlier tests adopted S1's suggestions, so decision events may come first.
    const msg = () => got.find((g) => g.params?.meta?.kind === 'message');
    for (let i = 0; i < 40 && !msg(); i++) await Bun.sleep(100);
    expect(got.every((g) => g.method === 'notifications/claude/channel')).toBe(true);
    expect(msg()?.params.content).toBe('over the channel\n\nAbout node n1: trip');
    expect(got.some((g) => g.params.meta.kind === 'decision' && g.params.content.includes('採用'))).toBe(true);
    // The position is recorded right after the notification is written; give it a moment.
    const want = Math.max(...got.map((g) => Number(g.params.meta.chat_id.slice(1))));
    const delivered = () => JSON.parse(readFileSync(join(dir, 'eda.json'), 'utf8')).sessions.find((s: any) => s.id === 'S1').delivered;
    for (let i = 0; i < 20 && delivered() !== want; i++) await Bun.sleep(100);
    expect(delivered()).toBe(want);
  } finally {
    await c.close();
    unregister();
  }
}, 15000);

test('a session whose cwd is not ASCII can reach its map', async () => {
  const jp = new Client('S7', '/tmp/日本語', () => [{ pid: 1, dir, host: '127.0.0.1', port: server.port!, startedAt: '' }]);
  expect(await runTool(jp, 'read_map', { map: dir })).toContain('[n1]');
  const s7 = (await person('GET', '/api/state')).json.doc.sessions.find((s: any) => s.id === 'S7');
  expect(s7.cwd).toBe('/tmp/日本語');
});

test('POST /api/nodes inserts at the given sibling index', async () => {
  const before = (await person('GET', '/api/state')).json.doc.root.children.map((c: any) => c.id);
  const { json } = await person('POST', '/api/nodes', { parentId: 'n1', text: 'first', index: 0 });
  const after = (await person('GET', '/api/state')).json.doc.root.children.map((c: any) => c.id);
  expect(after).toEqual([json.id, ...before]);
});

test('a session with no map is told how to start one', async () => {
  const lost = new Client('S9', '/w', () => []);
  await expect(runTool(lost, 'read_map', {})).rejects.toThrow(/eda serve/);
});

test('a person sets and clears a marker; the AI reads it, and its suggestions cannot carry one', async () => {
  const n = (await person('POST', '/api/nodes', { parentId: 'n1', text: 'marked' })).json;
  expect((await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'done', on: true })).json.markers).toEqual(['done']);
  expect((await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'nope', on: true })).status).toBe(400);
  const noOn = await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'flag' });
  expect([noOn.status, noOn.json.error]).toEqual([400, 'on (true / false) is required']);
  // Saved, not only held in memory.
  expect(JSON.stringify(loadMap(dir)!.root)).toContain('"markers":["done"]');
  // on: false goes through the route too.
  await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'flag', on: true });
  expect((await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'flag', on: false })).json.markers).toEqual(['done']);
  // The same request twice lands on the same state: the route sets, it does not toggle.
  await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'star', on: true });
  expect((await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'star', on: true })).json.markers).toEqual(['done', 'star']);
  await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'star', on: false });
  expect(await runTool(claude, 'read_map', {})).toContain('markers: done');
  // An AI edit carrying markers: the field is not read, so adopting it changes none.
  const r = await fetch(`${base}/api/ai/suggest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aiToken()}`, 'content-type': 'application/json', 'x-eda-session': 'S9' },
    body: JSON.stringify({ kind: 'edit', nodeId: n.id, text: 'marked!', markers: ['flag'], reason: 'r' }),
  });
  const s = (await r.json()) as { id: string };
  await person('POST', `/api/suggestions/${s.id}/accept`, {});
  const after = (await person('GET', '/api/state')).json.doc.root.children.find((c: { id: string }) => c.id === n.id);
  expect(after.text).toBe('marked!');
  expect(after.markers).toEqual(['done']);
});
