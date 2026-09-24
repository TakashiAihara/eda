import { expect, test } from 'bun:test';
import { accept, addChild, diffOutline, find, newMap, parseKaneoUrl, parseMarkdown, reject, removeNode, suggest, toMarkdown } from '../src/map.ts';

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
});

test('kaneo task URLs are parsed into ids', () => {
  expect(parseKaneoUrl('https://k.example/dashboard/workspace/W/project/P/task/T?x=1')).toEqual({ workspace: 'W', project: 'P', task: 'T' });
  expect(() => parseKaneoUrl('https://k.example/')).toThrow(/kaneo/);
});
