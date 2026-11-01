import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  accept,
  addChild,
  addUrl,
  editNode,
  kaneoTaskUrl,
  newMap,
  parseKaneoUrl,
  reject,
  removeNode,
  removeUrl,
  suggest,
  taskDescription,
  toMarkdown,
  setMarker,
  toOutlineForAi,
} from '../src/map.ts';

const made: string[] = [];
const temp = (prefix: string): string => {
  const d = mkdtempSync(joinPath(tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const ai = { by: 'ai' as const, session: 'S1' };

test('an AI suggestion does not enter the map until a person adopts it', () => {
  const d = newMap('plan');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'budget', reason: 'money first' }, ai);
  expect(d.root.children).toHaveLength(0);
  const n = accept(d, s.id);
  expect(d.root.children.map((c) => c.text)).toEqual(['budget']);
  expect(n.origin).toEqual(ai);
  expect(d.suggestions).toHaveLength(0);
});

test('three suggestions per session wait at a time', () => {
  const d = newMap('plan');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'a', reason: '' }, ai);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'a2', reason: '' }, ai);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'a3', reason: '' }, ai);
  expect(() => suggest(d, { kind: 'add', parentId: 'n1', text: 'b', reason: '' }, ai)).toThrow(/at most 3 at a time/);
  // another session has its own slots
  suggest(d, { kind: 'add', parentId: 'n1', text: 'b', reason: '' }, { by: 'ai', session: 'S2' });
  reject(d, s.id);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'c', reason: '' }, ai);
  expect(d.suggestions.map((x) => x.text)).toEqual(['a2', 'a3', 'b', 'c']);
});

test('adopting a suggestion frees its slot', () => {
  const d = newMap('plan');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'a', reason: '' }, ai);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'b', reason: '' }, ai);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'c', reason: '' }, ai);
  accept(d, s.id);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'd', reason: '' }, ai);
  expect(d.suggestions.map((x) => x.text)).toEqual(['b', 'c', 'd']);
});

test('adopting after rewriting keeps the AI as origin and uses the person\'s text and urls', () => {
  const d = newMap('plan');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'draft', urls: ['https://a.example/'], reason: '' }, ai);
  const n = accept(d, s.id, { text: 'final', urls: ['https://b.example/'] });
  expect(n.text).toBe('final');
  expect(n.urls.map((u) => u.url)).toEqual(['https://b.example/']);
  expect(n.origin.by).toBe('ai');
});

test('an edit suggestion changes text and attaches urls on adoption only', () => {
  const d = newMap('plan');
  const n = addChild(d, 'n1', 'old');
  const s = suggest(d, { kind: 'edit', nodeId: n.id, urls: ['https://x.example/doc'], reason: 'source' }, ai);
  expect(n.urls).toHaveLength(0);
  accept(d, s.id);
  expect(n.urls[0]?.url).toBe('https://x.example/doc');
  expect(n.urls[0]?.origin.by).toBe('ai');
  expect(n.text).toBe('old');

  const t = suggest(d, { kind: 'edit', nodeId: n.id, text: 'new', reason: '' }, ai);
  expect(n.text).toBe('old');
  accept(d, t.id);
  expect(n.text).toBe('new');
  expect(n.origin.by).toBe('human');
  expect(n.editedBy).toEqual(ai);
  editNode(d, n.id, { text: 'mine again' });
  expect(n.editedBy).toEqual({ by: 'human' });
});

test('an adoption that fails changes nothing', () => {
  const d = newMap('plan');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'x', reason: '' }, ai);
  const before = JSON.stringify(d);
  expect(() => accept(d, s.id, { urls: ['not a url'] })).toThrow(/http/);
  expect(JSON.stringify(d)).toBe(before);
});

test('a URL is removed by the form it was given in', () => {
  const d = newMap('plan');
  addUrl(d, 'n1', 'https://example.com');
  expect(d.root.urls[0]?.url).toBe('https://example.com/');
  removeUrl(d, 'n1', 'https://example.com');
  expect(d.root.urls).toHaveLength(0);
});

test('suggestions validate their target and urls', () => {
  const d = newMap('plan');
  expect(() => suggest(d, { kind: 'add', parentId: 'nope', text: 'x', reason: '' }, ai)).toThrow(/no node/);
  expect(() => suggest(d, { kind: 'add', parentId: 'n1', text: 'x', urls: ['javascript:alert(1)'], reason: '' }, ai)).toThrow(/http/);
  expect(() => suggest(d, { kind: 'edit', nodeId: 'n1', reason: '' }, ai)).toThrow(/text or urls/);
});

test('removing a node drops suggestions aimed at it', () => {
  const d = newMap('plan');
  const n = addChild(d, 'n1', 'x');
  suggest(d, { kind: 'add', parentId: n.id, text: 'y', reason: '' }, ai);
  removeNode(d, n.id);
  expect(d.root.children).toHaveLength(0);
  expect(d.suggestions).toHaveLength(0);
  expect(() => removeNode(d, 'n1')).toThrow(/root/);
});

test('map.md is the tree as nested bullets under the root heading', () => {
  const d = newMap('plan');
  const a = addChild(d, 'n1', 'a');
  addChild(d, a.id, 'a1');
  addChild(d, 'n1', 'b');
  expect(toMarkdown(d.root)).toBe('# plan\n\n- a\n  - a1\n- b\n');
});

test('a map.md candidate saved before map.md became export-only still adopts with the lines under it', () => {
  const d = newMap('p');
  d.suggestions.push({ id: 's9', kind: 'add', parentId: 'n1', text: 'b', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' }, at: '', children: [{ text: 'b1', children: [{ text: 'b2', children: [] }] }] });
  const n = accept(d, 's9');
  expect([n.text, n.origin.by]).toEqual(['b', 'md-edit']);
  expect(n.children.map((c) => [c.text, c.origin.by, c.children.map((g) => g.text)])).toEqual([['b1', 'md-edit', ['b2']]]);
});

test('an add adopted with an emptied text is refused', () => {
  const d = newMap('p');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'x', reason: '' }, ai);
  expect(() => accept(d, s.id, { text: '' })).toThrow(/empty/);
  expect(() => accept(d, s.id, { text: null })).toThrow(/empty/);
  expect(d.suggestions).toHaveLength(1);
});

test('kaneo task URLs are parsed into ids', () => {
  expect(parseKaneoUrl('https://k.example/dashboard/workspace/W/project/P/task/T?x=1')).toEqual({ workspace: 'W', project: 'P', task: 'T' });
  expect(() => parseKaneoUrl('https://k.example/')).toThrow(/kaneo/);
  expect(kaneoTaskUrl('https://k.example/', { workspace: 'W', project: 'P', task: 'T' })).toBe('https://k.example/dashboard/workspace/W/project/P/task/T');
});

test('a task description carries what a session needs without the map', () => {
  const d = newMap('trip');
  const hotel = addChild(d, 'n1', 'hotel');
  const booking = addChild(d, hotel.id, 'book a room near the station');
  addChild(d, hotel.id, 'compare prices');
  addChild(d, booking.id, 'ryokan or hotel');
  editNode(d, booking.id, { note: 'two nights' });
  addUrl(d, booking.id, 'https://example.com/hotels');

  const text = taskDescription(d, booking.id, '/maps/trip');
  // The path is where it sits, the siblings and children what is around it, and the last
  // section is how the session gets back to the node it came from.
  expect(text.split('\n')[0]).toBe('trip > hotel > book a room near the station');
  expect(text).toContain('- compare prices');
  expect(text).toContain('- ryokan or hotel');
  expect(text).toContain('two nights');
  expect(text).toContain('- https://example.com/hotels');
  expect(text).toContain('- マップ: /maps/trip');
  expect(text).toContain(`- ノード: ${booking.id}`);
  // The node is the path, not one of its own siblings.
  expect(text).not.toContain('- book a room near the station');
  // Markdown kaneo renders: a section is a blank line away from the one before it, and its
  // items are list items. Single newlines would merge the sections into one paragraph.
  expect(text).toBe(
    [
      'trip > hotel > book a room near the station',
      '',
      '兄弟:',
      '- compare prices',
      '',
      '子:',
      '- ryokan or hotel',
      '',
      'ノート:',
      'two nights',
      '',
      'URL:',
      '- https://example.com/hotels',
      '',
      '元のノード:',
      '- マップ: /maps/trip',
      `- ノード: ${booking.id}`,
    ].join('\n'),
  );
  // A node with nothing around it gets only the path and the way back: a section with
  // nothing in it is left out rather than shown as an empty heading.
  const solo = newMap('solo');
  expect(taskDescription(solo, 'n1', '/maps/solo')).toBe('solo\n\n元のノード:\n- マップ: /maps/solo\n- ノード: n1');
  expect(() => taskDescription(d, 'nope', '/maps/trip')).toThrow(/no node/);
});

test('a map directory can be claimed by one live process at a time', async () => {
  const { lockMap } = await import('../src/store.ts');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = temp('eda-lock-');
  const release = lockMap(dir);
  expect(typeof release).toBe('function');
  expect(lockMap(dir)).toBe(process.pid);
  (release as () => void)();
  writeFileSync(join(dir, 'eda.lock'), '999999999');
  expect(typeof lockMap(dir)).toBe('function');
});

test('processes racing for one map directory: exactly one wins', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = temp('eda-race-');
  const go = join(dir, 'go');
  // A dead owner's lock is there first, so every racer goes through the takeover.
  writeFileSync(join(dir, 'eda.lock'), '999999999');
  const script = `
    import { existsSync } from 'node:fs';
    import { lockMap } from '${join(import.meta.dir, '../src/store.ts')}';
    while (!existsSync('${go}')) await Bun.sleep(5);
    const r = lockMap('${dir}');
    console.log(typeof r === 'function' ? 'won' : 'lost');
    await Bun.sleep(300);`;
  const procs = Array.from({ length: 8 }, () => Bun.spawn(['bun', '-e', script], { stdout: 'pipe' }));
  await Bun.sleep(400);
  writeFileSync(go, '');
  const out = (await Promise.all(procs.map((p) => new Response(p.stdout).text()))).map((o) => o.trim());
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual(Array(8).fill(0));
  expect(out.filter((o) => o === 'won')).toHaveLength(1);
  expect(out.filter((o) => o === 'lost')).toHaveLength(7);
});

test('adopting or rejecting an AI suggestion leaves a note for the session that made it', () => {
  const d = newMap('p');
  const a = suggest(d, { kind: 'add', parentId: 'n1', text: 'x', reason: '' }, ai);
  const n = accept(d, a.id, { text: 'y' });
  const b = suggest(d, { kind: 'add', parentId: 'n1', text: 'z', reason: '' }, ai);
  reject(d, b.id);
  expect(d.chat.map((c) => [c.from, c.session, c.nodeId, c.text])).toEqual([
    ['system', 'S1', n.id, `${a.id} 直して採用: 本文「y」 → ${n.id}`],
    ['system', 'S1', 'n1', `${b.id} 却下: 「z」`],
  ]);
});

test('the note says what actually went in when the person kept the text and dropped the URLs', () => {
  const d = newMap('p');
  const n = addChild(d, 'n1', 'original');
  const s = suggest(d, { kind: 'edit', nodeId: n.id, text: 'replacement', urls: ['https://u.example/'], reason: '' }, ai);
  accept(d, s.id, { text: null, urls: [] });
  expect(n.text).toBe('original');
  expect(d.chat.at(-1)?.text).toBe(`${s.id} 直して採用: 本文は変えず → ${n.id}`);
  const t = suggest(d, { kind: 'add', parentId: 'n1', text: 'as is', reason: '' }, ai);
  accept(d, t.id);
  expect(d.chat.at(-1)?.text).toMatch(/^s\d+ 採用: 本文「as is」 → n\d+$/);
});

test('deleting the node a suggestion was aimed at tells the session it was cancelled', () => {
  const d = newMap('p');
  const n = addChild(d, 'n1', 'x');
  const s = suggest(d, { kind: 'add', parentId: n.id, text: 'under x', reason: '' }, ai);
  removeNode(d, n.id);
  expect(d.chat.at(-1)).toMatchObject({ from: 'system', session: 'S1', nodeId: 'n1', text: `${s.id} 取り消し: 「under x」の対象ノードが削除された` });
});

test('a node can be inserted at a sibling index (Enter / Shift+Enter)', () => {
  const d = newMap('p');
  addChild(d, 'n1', 'a');
  addChild(d, 'n1', 'c');
  addChild(d, 'n1', 'b', { by: 'human' }, 1);
  addChild(d, 'n1', 'z', { by: 'human' }, 99);
  expect(d.root.children.map((c) => c.text)).toEqual(['a', 'b', 'c', 'z']);
});

test('markers go on and off, and one of a group replaces the other', () => {
  const d = newMap('plan');
  const n = addChild(d, 'n1', 'hotel');
  setMarker(d, n.id, 'flag', true);
  setMarker(d, n.id, 'priority-2', true);
  setMarker(d, n.id, 'doing', true);
  // Kept in the fixed order, whatever order they were set in.
  expect(n.markers).toEqual(['priority-2', 'doing', 'flag']);
  setMarker(d, n.id, 'priority-1', true);
  setMarker(d, n.id, 'done', true);
  expect(n.markers).toEqual(['priority-1', 'done', 'flag']);
  // flag and star are groups of their own: both can be on.
  setMarker(d, n.id, 'star', true);
  expect(n.markers).toEqual(['priority-1', 'done', 'flag', 'star']);
  // Repeating a request lands on the same state (a double key press, a retry).
  setMarker(d, n.id, 'star', true);
  expect(n.markers).toEqual(['priority-1', 'done', 'flag', 'star']);
  // Taking off one that is not there changes nothing, even with another of its group on.
  setMarker(d, n.id, 'priority-2', false);
  expect(n.markers).toEqual(['priority-1', 'done', 'flag', 'star']);
  // Taking one off leaves the others alone.
  setMarker(d, n.id, 'priority-1', false);
  expect(n.markers).toEqual(['done', 'flag', 'star']);
  setMarker(d, n.id, 'priority-2', false);
  expect(n.markers).toEqual(['done', 'flag', 'star']);
  for (const m of ['done', 'flag', 'star', 'star']) setMarker(d, n.id, m, false);
  expect('markers' in n).toBe(false);
});

test('an unknown marker is refused, and the AI reads the markers', () => {
  const d = newMap('plan');
  const n = addChild(d, 'n1', 'hotel');
  expect(() => setMarker(d, n.id, 'urgent', true)).toThrow(/unknown marker/);
  expect(n.markers).toBeUndefined();
  setMarker(d, n.id, 'question', true);
  expect(toOutlineForAi(d)).toContain(`[${n.id}] hotel  (markers: question)`);
});

test('a node takes one waiting edit, whoever suggests it, until the person decides', () => {
  const d = newMap('p');
  const n = addChild(d, 'n1', 'a');
  const other = addChild(d, 'n1', 'b');
  const another = { by: 'ai', session: 'S-other', model: 'm' } as const;
  suggest(d, { kind: 'edit', nodeId: other.id, text: 'b2', reason: '' }, ai);
  const first = suggest(d, { kind: 'edit', nodeId: n.id, text: 'a2', reason: '' }, ai);
  suggest(d, { kind: 'add', parentId: n.id, text: 'child', reason: '' }, another);
  const before = JSON.stringify(d);

  let refused: unknown;
  try {
    suggest(d, { kind: 'edit', nodeId: n.id, urls: ['https://x.example/'], reason: '' }, another);
  } catch (e) {
    refused = e;
  }
  expect((refused as Error).message).toBe(`${first.id} already suggests a change to ${n.id} and is waiting for the person`);
  expect((refused as { status: number }).status).toBe(409);
  expect(JSON.stringify(d)).toBe(before);

  reject(d, first.id);
  const second = suggest(d, { kind: 'edit', nodeId: n.id, text: 'a3', reason: '' }, another);
  expect(() => suggest(d, { kind: 'edit', nodeId: n.id, text: 'a4', reason: '' }, another)).toThrow(`${second.id} already suggests`);
  accept(d, second.id);
  expect(n.text).toBe('a3');
  expect(suggest(d, { kind: 'edit', nodeId: n.id, text: 'a5', reason: '' }, another).kind).toBe('edit');
});
