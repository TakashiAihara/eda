import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'eda-home-'));
process.env['EDA_HOME'] = home;
const { startServer } = await import('../src/server.ts');
const { Client, runTool } = await import('../src/mcp.ts');
const { token } = await import('../src/store.ts');

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
  await person('POST', '/api/chat', { text: 'what about budget?', nodeId: 'n1' });
  expect(await runTool(claude, 'reply', { text: 'set a ceiling first' })).toBe('posted');
  const doc = (await person('GET', '/api/state')).json.doc;
  expect(doc.chat.map((c: any) => [c.from, c.text])).toEqual([
    ['human', 'what about budget?'],
    ['ai', 'set a ceiling first'],
  ]);
  expect(doc.root.children).toHaveLength(1);
});

test('a session with no map is told how to start one', async () => {
  const lost = new Client('S9', '/w', () => []);
  await expect(runTool(lost, 'read_map', {})).rejects.toThrow(/eda serve/);
});
