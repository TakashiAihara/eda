import { expect, test } from 'bun:test';
import {
  accept,
  addChild,
  addCandidates,
  addUrl,
  diffOutline,
  editNode,
  find,
  kaneoTaskUrl,
  newMap,
  parseKaneoUrl,
  parseMarkdown,
  reject,
  removeNode,
  removeUrl,
  suggest,
  toMarkdown,
} from '../src/map.ts';

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

test('one suggestion per session waits at a time', () => {
  const d = newMap('plan');
  const s = suggest(d, { kind: 'add', parentId: 'n1', text: 'a', reason: '' }, ai);
  expect(() => suggest(d, { kind: 'add', parentId: 'n1', text: 'b', reason: '' }, ai)).toThrow(/one at a time/);
  // another session (or model) has its own slot
  suggest(d, { kind: 'add', parentId: 'n1', text: 'b', reason: '' }, { by: 'ai', session: 'S2' });
  reject(d, s.id);
  suggest(d, { kind: 'add', parentId: 'n1', text: 'c', reason: '' }, ai);
  expect(d.suggestions.map((x) => x.text)).toEqual(['b', 'c']);
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

test('markdown round-trips and a hand edit becomes candidates, not changes', () => {
  const d = newMap('plan');
  const a = addChild(d, 'n1', 'a');
  addChild(d, a.id, 'a1');
  const md = toMarkdown(d.root);
  expect(md).toBe('# plan\n\n- a\n  - a1\n');
  expect(diffOutline(d, parseMarkdown(md))).toEqual([]);

  const edited = parseMarkdown('# plan\n\n- A\n    - a1\n    - a2\n- b\n  - b1\n');
  const found = diffOutline(d, edited);
  expect(found.map((f) => [f.kind, f.text])).toEqual([
    ['edit', 'A'],
    ['add', 'a2'],
    ['add', 'b'],
  ]);
  expect(find(d.root, a.id)?.node.text).toBe('a');

  // the lines under a new line come with it
  addCandidates(d, found);
  const b = d.suggestions.find((s) => s.text === 'b')!;
  const nb = accept(d, b.id);
  expect(nb.children.map((c) => [c.text, c.origin.by])).toEqual([['b1', 'md-edit']]);
  // the same hand edit seen twice is offered once
  addCandidates(d, diffOutline(d, edited));
  expect(d.suggestions.filter((s) => s.text === 'a2')).toHaveLength(1);
});

test('two identical new sibling lines are two candidates, and seeing the edit again adds none', () => {
  const d = newMap('p');
  const edit = parseMarkdown('# p\n\n- same\n- same\n');
  addCandidates(d, diffOutline(d, edit));
  addCandidates(d, diffOutline(d, edit));
  expect(d.suggestions.map((s) => s.text)).toEqual(['same', 'same']);
});

test('two new lines with the same text but different children are two candidates', () => {
  const d = newMap('p');
  addCandidates(d, diffOutline(d, parseMarkdown('# p\n\n- same\n  - x\n')));
  addCandidates(d, diffOutline(d, parseMarkdown('# p\n\n- same\n  - x\n- other\n')));
  addCandidates(d, diffOutline(d, parseMarkdown('# p\n\n- same\n  - y\n')));
  expect(d.suggestions.map((s) => [s.text, s.kind === 'add' ? s.children?.map((c) => c.text) : null])).toEqual([
    ['same', ['x']],
    ['other', undefined],
    ['same', ['y']],
  ]);
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

test('a map directory can be claimed by one live process at a time', async () => {
  const { lockMap } = await import('../src/store.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'eda-lock-'));
  const release = lockMap(dir);
  expect(typeof release).toBe('function');
  expect(lockMap(dir)).toBe(process.pid);
  (release as () => void)();
  writeFileSync(join(dir, 'eda.lock'), '999999999');
  expect(typeof lockMap(dir)).toBe('function');
});

test('processes racing for one map directory: exactly one wins', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'eda-race-'));
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
