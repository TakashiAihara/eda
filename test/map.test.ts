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
  setMarker,
  toOutlineForAi,
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

test('a line deleted from between its siblings leaves nothing to offer', () => {
  const d = newMap('p');
  for (const t of ['a', 'b', 'c', 'd']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- c\n- d\n'))).toEqual([]);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- c\n- D\n'))).toEqual([
    { kind: 'edit', nodeId: 'n5', text: 'D', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('the last of the siblings goes the same way as one in the middle', () => {
  const d = newMap('p');
  for (const t of ['a', 'b', 'c']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- b\n'))).toEqual([]);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- b\n- C\n'))).toEqual([
    { kind: 'edit', nodeId: 'n4', text: 'C', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a line inserted between its siblings is one addition and no edits', () => {
  const d = newMap('p');
  for (const t of ['a', 'b', 'c']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- X\n- b\n- c\n'))).toEqual([
    { kind: 'add', parentId: 'n1', text: 'X', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a line rewritten between its siblings is one edit of that line', () => {
  const d = newMap('p');
  for (const t of ['a', 'b', 'c']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- B\n- c\n'))).toEqual([
    { kind: 'edit', nodeId: 'n3', text: 'B', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a line deleted next to a rewritten one is not offered, and the rewrite lands on the first of the pair', () => {
  const d = newMap('p');
  for (const t of ['a', 'b', 'c', 'd']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- C\n- d\n'))).toEqual([
    { kind: 'edit', nodeId: 'n3', text: 'C', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a deleted line before a branch does not move the lines under the branch after it', () => {
  const d = newMap('p');
  const a = addChild(d, 'n1', 'a');
  addChild(d, a.id, 'a1');
  addChild(d, 'n1', 'b');
  const c = addChild(d, 'n1', 'c');
  addChild(d, c.id, 'c1');
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n  - a1\n- c\n  - c2\n'))).toEqual([
    { kind: 'edit', nodeId: 'n6', text: 'c2', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('two siblings with one text are told apart by what is under them', () => {
  const d = newMap('p');
  const one = addChild(d, 'n1', 'a');
  addChild(d, one.id, 'A');
  const two = addChild(d, 'n1', 'a');
  addChild(d, two.id, 'B');
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n  - B\n'))).toEqual([]);
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n  - B\n- z\n'))).toEqual([
    { kind: 'add', parentId: 'n1', text: 'z', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a leaf renamed to a line that holds its old text below is still a rename', () => {
  const d = newMap('p');
  for (const t of ['a', 'b']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- x\n  - a\n- b\n'))).toEqual([
    { kind: 'edit', nodeId: 'n2', text: 'x', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    { kind: 'add', parentId: 'n2', text: 'a', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a deletion before a matched branch does not shift the lines compared after it', () => {
  const d = newMap('p');
  addChild(d, 'n1', 'x');
  const a = addChild(d, 'n1', 'a');
  addChild(d, a.id, 'A');
  const c = addChild(d, 'n1', 'c');
  const under = addChild(d, c.id, 'C');
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n  - A\n- c\n  - D\n'))).toEqual([
    { kind: 'edit', nodeId: under.id, text: 'D', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a line renamed to its sibling text is a rename, not a second copy', () => {
  const d = newMap('p');
  for (const t of ['a', 'b']) addChild(d, 'n1', t);
  expect(diffOutline(d, parseMarkdown('# p\n\n- b\n- b\n'))).toEqual([
    { kind: 'edit', nodeId: 'n2', text: 'b', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
  // The same with both ends changed too, so the shared ends cannot settle it and the tie does.
  const e = newMap('p');
  for (const t of ['x', 'a', 'b', 'y']) addChild(e, 'n1', t);
  expect(diffOutline(e, parseMarkdown('# p\n\n- X\n- b\n- b\n- Y\n'))).toEqual([
    { kind: 'edit', nodeId: 'n2', text: 'X', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    { kind: 'edit', nodeId: 'n3', text: 'b', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    { kind: 'edit', nodeId: 'n5', text: 'Y', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a line moved down with a child added elsewhere keeps every text match', () => {
  const d = newMap('p');
  addChild(d, 'n1', 'a');
  addChild(d, 'n1', 'b');
  const c = addChild(d, 'n1', 'c');
  addChild(d, c.id, '1');
  expect(diffOutline(d, parseMarkdown('# p\n\n- b\n  - 1\n- c\n  - 1\n- a\n'))).toEqual([
    { kind: 'add', parentId: 'n3', text: '1', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    { kind: 'add', parentId: 'n1', text: 'a', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a retitle next to a deletion lands on the node whose children it carries', () => {
  const d = newMap('p');
  addChild(d, 'n1', 'a');
  const b = addChild(d, 'n1', 'b');
  addChild(d, b.id, 'b1');
  const c = addChild(d, 'n1', 'c');
  addChild(d, c.id, 'c1');
  addChild(d, 'n1', 'd');
  expect(diffOutline(d, parseMarkdown('# p\n\n- a\n- C\n  - c1\n- d\n'))).toEqual([
    { kind: 'edit', nodeId: c.id, text: 'C', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('two siblings with one text are told apart by the child lines left under one of them', () => {
  const d = newMap('p');
  const one = addChild(d, 'n1', 'same');
  addChild(d, one.id, 'A');
  const two = addChild(d, 'n1', 'same');
  addChild(d, two.id, 'B');
  addChild(d, two.id, 'C');
  expect(diffOutline(d, parseMarkdown('# p\n\n- same\n  - B\n'))).toEqual([]);
  // Both share A with the line; only the second matches it whole.
  const e = newMap('p');
  const first = addChild(e, 'n1', 'same');
  addChild(e, first.id, 'A');
  const second = addChild(e, 'n1', 'same');
  addChild(e, second.id, 'A');
  addChild(e, second.id, 'B');
  const z = addChild(e, 'n1', 'z');
  // z changes too, so the shared ends do not settle it before the weights do.
  expect(diffOutline(e, parseMarkdown('# p\n\n- same\n  - A\n  - B\n- Z\n'))).toEqual([
    { kind: 'edit', nodeId: z.id, text: 'Z', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
  // C rewritten to D: the change lands under the second, which still carries B.
  expect(diffOutline(d, parseMarkdown('# p\n\n- same\n  - B\n  - D\n'))).toEqual([
    { kind: 'edit', nodeId: 'n6', text: 'D', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('a text match is never traded for two retitles', () => {
  const d = newMap('p');
  const a = addChild(d, 'n1', 'a');
  addChild(d, a.id, 'z');
  const c = addChild(d, 'n1', 'c');
  addChild(d, c.id, 'w');
  addChild(d, 'n1', 'b');
  const z = { text: 'z', children: [] };
  const w = { text: 'w', children: [] };
  expect(diffOutline(d, parseMarkdown('# p\n\n- b\n- X\n  - z\n- Y\n  - w\n'))).toEqual([
    { kind: 'add', parentId: 'n1', text: 'X', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' }, children: [z] },
    { kind: 'add', parentId: 'n1', text: 'Y', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' }, children: [w] },
  ]);
});

test('a whole-subtree match never costs two text matches', () => {
  const d = newMap('p');
  const a = addChild(d, 'n1', 'a');
  addChild(d, a.id, '1');
  addChild(d, 'n1', 'b');
  addChild(d, 'n1', 'c');
  // b and c both changed underneath, so only a matches whole; the two text matches still win.
  expect(diffOutline(d, parseMarkdown('# p\n\n- b\n  - x\n- c\n  - y\n- a\n  - 1\n'))).toEqual([
    { kind: 'add', parentId: 'n4', text: 'x', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    { kind: 'add', parentId: 'n5', text: 'y', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    { kind: 'add', parentId: 'n1', text: 'a', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' }, children: [{ text: '1', children: [] }] },
  ]);
});

test('two siblings swapped are read as one addition', () => {
  const d = newMap('p');
  for (const t of ['a', 'b']) addChild(d, 'n1', t);
  // The tie has two answers of the same length; this pins which one, so the backtrack is not free to flip.
  expect(diffOutline(d, parseMarkdown('# p\n\n- b\n- a\n'))).toEqual([
    { kind: 'add', parentId: 'n1', text: 'b', urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
  ]);
});

test('one edit near either end of a long list of siblings is one candidate', () => {
  const d = newMap('p');
  for (let i = 0; i < 6000; i++) addChild(d, 'n1', `l${i}`);
  const md = (at: number) => parseMarkdown(`# p\n\n${Array.from({ length: 6000 }, (_, i) => (i === at ? `- L${i}` : `- l${i}`)).join('\n')}\n`);
  // The cost of peeling off the shared ends is not pinned here: measured by hand at about 100 ms
  // with it and 1.3 s / 355 MB without, and a time limit in a test run did not tell the two apart.
  for (const [line, id] of [[1000, 'n1002'], [5000, 'n5002']] as const) {
    expect(diffOutline(d, md(line))).toEqual([
      { kind: 'edit', nodeId: id, text: `L${line}`, urls: [], reason: 'edited in map.md', source: { by: 'md-edit' } },
    ]);
  }
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
