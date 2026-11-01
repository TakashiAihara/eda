import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const { loadMap, token } = await import('../src/store.ts');
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

test('starting on an existing map writes map.md again, from eda.json', () => {
  const d = temp('eda-md-');
  const first = startServer({ dir: d, host: '127.0.0.1', port: 0, title: 'trip' });
  first.stop();
  writeFileSync(join(d, 'map.md'), '# stale\n');
  const again = startServer({ dir: d, host: '127.0.0.1', port: 0 });
  again.stop();
  expect(readFileSync(join(d, 'map.md'), 'utf8')).toBe('# trip\n\n');
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

test('an AI call without a session is refused', async () => {
  const r = await fetch(`${base}/api/ai/suggest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
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
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', 'x-eda-session': 'S9' },
    body: JSON.stringify({ kind: 'edit', nodeId: n.id, text: 'marked!', markers: ['flag'], reason: 'r' }),
  });
  const s = (await r.json()) as { id: string };
  await person('POST', `/api/suggestions/${s.id}/accept`, {});
  const after = (await person('GET', '/api/state')).json.doc.root.children.find((c: { id: string }) => c.id === n.id);
  expect(after.text).toBe('marked!');
  expect(after.markers).toEqual(['done']);
});
