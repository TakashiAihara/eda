import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'eda-home-'));
process.env['EDA_HOME'] = home;
// Never the real ~/.config/eda: a kaneo host there would change what the tests see.
process.env['XDG_CONFIG_HOME'] = home;
const { startServer } = await import('../src/server.ts');
const { Client, describe: describeChat, runTool, undelivered } = await import('../src/mcp.ts');
const { loadMap, token } = await import('../src/store.ts');

const dir = mkdtempSync(join(tmpdir(), 'eda-map-'));
const { server } = startServer({ dir, host: '127.0.0.1', port: 0, title: 'trip', session: 'S1', cwd: '/w' });
afterAll(() => server.stop(true));

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

test('Claude reads, suggests one node, is refused a second, and the person adopts', async () => {
  expect(await runTool(claude, 'read_map', {})).toContain('- [n1] trip');
  expect(await runTool(claude, 'suggest_node', { parent_id: 'n1', text: 'where to stay', reason: 'r' })).toMatch(/waiting/);
  await expect(runTool(claude, 'suggest_node', { parent_id: 'n1', text: 'food', reason: 'r' })).rejects.toThrow(/one at a time/);

  const { json } = await person('GET', '/api/state');
  expect(json.doc.root.children).toHaveLength(0);
  const id = json.doc.suggestions[0].id;
  await person('POST', `/api/suggestions/${id}/accept`, { text: 'hotel' });
  const after = (await person('GET', '/api/state')).json.doc;
  expect(after.root.children[0].text).toBe('hotel');
  expect(after.root.children[0].origin).toEqual({ by: 'ai', session: 'S1' });
  expect(readFileSync(join(dir, 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n');
});

test('the session that started the map is recorded for resume', async () => {
  const { json } = await person('GET', '/api/state');
  expect(json.doc.sessions.map((s: any) => s.id)).toEqual(['S1']);
});

test('a hand edit of map.md is not applied: it comes back as candidates and the file is restored', async () => {
  writeFileSync(join(dir, 'map.md'), '# trip\n\n- hotel\n- flights\n');
  const { json } = await person('GET', '/api/state');
  expect(json.doc.root.children.map((c: any) => c.text)).toEqual(['hotel']);
  expect(json.doc.suggestions.map((s: any) => [s.source.by, s.text])).toEqual([['md-edit', 'flights']]);
  expect(readFileSync(join(dir, 'map.md'), 'utf8')).toBe('# trip\n\n- hotel\n');
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

test('attaching a session does not overwrite a pending hand edit of map.md', async () => {
  writeFileSync(join(dir, 'map.md'), '# trip\n\n- hotel\n- visa\n');
  const late = new Client('S3', '/y', () => [{ pid: 1, dir, host: '127.0.0.1', port: server.port!, startedAt: '' }]);
  await runTool(late, 'read_map', { map: dir });
  const doc = (await person('GET', '/api/state')).json.doc;
  expect(doc.suggestions.map((s: any) => s.text)).toContain('visa');
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

test('a directory with only a map.md keeps it: its lines come back as candidates', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'eda-md-'));
  writeFileSync(join(d2, 'map.md'), '# ideas\n\n- one\n  - one.a\n- two\n');
  const s2 = startServer({ dir: d2, host: '127.0.0.1', port: 0 });
  try {
    const doc = s2.doc;
    expect(doc.suggestions.map((s) => [s.kind, s.text, s.kind === 'add' ? s.children?.map((c) => c.text) : undefined])).toEqual([
      ['edit', 'ideas', undefined],
      ['add', 'one', ['one.a']],
      ['add', 'two', undefined],
    ]);
  } finally {
    s2.server.stop(true);
  }
});

test('a map.md edit saved while a request body is still arriving is read as an addition', async () => {
  const d3 = mkdtempSync(join(tmpdir(), 'eda-slow-'));
  const s3 = startServer({ dir: d3, host: '127.0.0.1', port: 0, title: 'r' });
  try {
    let push!: (s: string) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => {
          c.enqueue(new TextEncoder().encode(s));
          c.close();
        };
      },
    });
    const pending = fetch(`http://127.0.0.1:${s3.server.port}/api/nodes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await Bun.sleep(100);
    writeFileSync(join(d3, 'map.md'), '# r\n\n- editor child\n');
    push(JSON.stringify({ parentId: 'n1', text: 'browser child' }));
    expect((await pending).status).toBe(200);
    const doc = s3.doc;
    expect(doc.root.children.map((c) => c.text)).toEqual(['browser child']);
    expect(doc.suggestions.map((s) => [s.kind, s.text])).toEqual([['add', 'editor child']]);
  } finally {
    s3.server.stop(true);
  }
});

test('a map.md left over from a save cut short is rewritten, not offered as an edit', async () => {
  const { saveMap, syncMarkdown, openMap } = await import('../src/store.ts');
  const { addChild, removeNode } = await import('../src/map.ts');
  const d4 = mkdtempSync(join(tmpdir(), 'eda-crash-'));
  const doc = openMap(d4, 'c');
  const n = addChild(doc, 'n1', 'gone soon');
  saveMap(d4, doc);
  const oldMd = readFileSync(join(d4, 'map.md'), 'utf8');
  removeNode(doc, n.id);
  saveMap(d4, doc);
  // the crash: eda.json was written, map.md still the previous export, marker left behind
  writeFileSync(join(d4, 'map.md'), oldMd);
  writeFileSync(join(d4, '.eda-exporting'), '');
  const reloaded = loadMap(d4)!;
  syncMarkdown(d4, reloaded, true);
  expect(reloaded.suggestions).toEqual([]);
  expect(readFileSync(join(d4, 'map.md'), 'utf8')).toBe('# c\n\n');
});

test('restoring the previous map.md while eda was stopped is offered as an edit on start', async () => {
  const { saveMap, syncMarkdown, openMap } = await import('../src/store.ts');
  const { addChild, editNode } = await import('../src/map.ts');
  const d6 = mkdtempSync(join(tmpdir(), 'eda-offline-'));
  const doc = openMap(d6, 'o');
  const n = addChild(doc, 'n1', 'A');
  saveMap(d6, doc);
  editNode(doc, n.id, { text: 'B' });
  saveMap(d6, doc);
  writeFileSync(join(d6, 'map.md'), '# o\n\n- A\n');
  const reloaded = loadMap(d6)!;
  syncMarkdown(d6, reloaded, true);
  expect(reloaded.suggestions.map((s) => [s.kind, s.text])).toEqual([['edit', 'A']]);
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

test('restoring the previous map.md by hand while running is offered as an edit', async () => {
  const { saveMap, syncMarkdown, openMap } = await import('../src/store.ts');
  const { addChild, editNode } = await import('../src/map.ts');
  const d5 = mkdtempSync(join(tmpdir(), 'eda-undo-'));
  const doc = openMap(d5, 'u');
  const n = addChild(doc, 'n1', 'A');
  saveMap(d5, doc);
  editNode(doc, n.id, { text: 'B' });
  saveMap(d5, doc);
  writeFileSync(join(d5, 'map.md'), '# u\n\n- A\n');
  syncMarkdown(d5, doc);
  expect(doc.suggestions.map((s) => [s.kind, s.text])).toEqual([['edit', 'A']]);
});

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
  expect((await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'flag' })).status).toBe(400);
  // Saved, not only held in memory.
  expect(JSON.stringify(loadMap(dir)!.root)).toContain('"markers":["done"]');
  // on: false goes through the route too.
  await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'flag', on: true });
  expect((await person('POST', `/api/nodes/${n.id}/markers`, { marker: 'flag', on: false })).json.markers).toEqual(['done']);
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
