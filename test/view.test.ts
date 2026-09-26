import { expect, test } from 'bun:test';
import type { Node } from '../src/map.ts';
import { clampZoom, deepest, pathTo, topicColours, visibleSelection } from '../web/view.ts';

const n = (id: string, children: Node[] = [], collapsed = false): Node => ({ id, text: id, children, urls: [], tasks: [], origin: { by: 'human' }, ...(collapsed ? { collapsed } : {}) });

// n1 ─ n2 (collapsed) ─ n3 ─ n4
//    └ n5
const map = n('n1', [n('n2', [n('n3', [n('n4')])], true), n('n5')]);

test('pathTo walks root to node, empty when absent', () => {
  expect(pathTo(map, 'n4').map((x) => x.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
  expect(pathTo(map, 'n9')).toEqual([]);
  expect(pathTo(map.children[0]!, 'n5')).toEqual([]);
});

test('a selection hidden by a collapsed ancestor moves to it', () => {
  expect(visibleSelection(map, 'n4')).toBe('n2');
  expect(visibleSelection(map, 'n2')).toBe('n2');
  expect(visibleSelection(map, 'n5')).toBe('n5');
});

test('outside the drilled-down branch, or gone, the selection is the top', () => {
  expect(visibleSelection(map.children[0]!, 'n5')).toBe('n2');
  expect(visibleSelection(map, 'n9')).toBe('n1');
});

test('a drilled-down collapsed top still shows its children', () => {
  const top = map.children[0]!;
  expect(visibleSelection(top, 'n3', true)).toBe('n3');
  expect(visibleSelection(top, 'n3')).toBe('n2');
  // Only the top's own flag is skipped: a collapsed node below it still hides its subtree.
  expect(visibleSelection(map, 'n4', true)).toBe('n2');
});

test('a depth limit hides what is below it, and the selection moves up to that level', () => {
  const open = n('n1', [n('n2', [n('n3', [n('n4')])]), n('n5')]);
  expect(visibleSelection(open, 'n4', false, 1)).toBe('n2');
  expect(visibleSelection(open, 'n4', false, 2)).toBe('n3');
  expect(visibleSelection(open, 'n4', false, 3)).toBe('n4');
  expect(visibleSelection(open, 'n5', false, 1)).toBe('n5');
  // A collapsed node above the limit still wins.
  expect(visibleSelection(map, 'n4', false, 3)).toBe('n2');
});

test('topic colours follow creation order, not position, and differ for the first six', () => {
  const c = topicColours(['n30', 'n4', 'n17']);
  expect([c.get('n4'), c.get('n17'), c.get('n30')]).toEqual([0, 1, 2]);
  // An insert before the others, created later, takes the next colour and moves none.
  const after = topicColours(['n31', 'n30', 'n4', 'n17']);
  expect([after.get('n4'), after.get('n17'), after.get('n30'), after.get('n31')]).toEqual([0, 1, 2, 3]);
  // n9 sorts before n10 as a number, not as a string.
  expect(topicColours(['n10', 'n9']).get('n9')).toBe(0);
  // Out of order on purpose, so a position-based colour would fail these.
  const six = topicColours(['n20', 'n2', 'n14', 'n5', 'n11', 'n8']);
  expect(['n2', 'n5', 'n8', 'n11', 'n14', 'n20'].map((id) => six.get(id))).toEqual([0, 1, 2, 3, 4, 5]);
  // The palette has six slots: the seventh wraps to the first.
  expect(topicColours(['n1', 'n7', 'n2', 'n3', 'n4', 'n5', 'n6']).get('n7')).toBe(0);
});

test('deepest counts levels with something drawn: children, and suggestions waiting under a node', () => {
  const none = () => 0;
  const open = n('n1', [n('n2', [n('n3')]), n('n5')]);
  expect(deepest(open, none)).toBe(2);
  expect(deepest(n('n1'), none)).toBe(0);
  // A suggestion waiting under a leaf adds a level; so does one under a collapsed node.
  expect(deepest(open, (id) => (id === 'n3' ? 1 : 0))).toBe(3);
  expect(deepest(map, (id) => (id === 'n2' ? 1 : 0))).toBe(2);
  // One under a node that a collapsed ancestor hides does not count.
  expect(deepest(map, (id) => (id === 'n3' ? 1 : 0))).toBe(1);
  // A collapsed node hides its children, unless it is a drilled-down top that shows them.
  expect(deepest(map, none)).toBe(1);
  expect(deepest(map.children[0]!, none)).toBe(0);
  expect(deepest(map.children[0]!, none, true)).toBe(2);
});

test('zoom is clamped and rounded, and junk falls back to 1', () => {
  expect(clampZoom(10)).toBe(2);
  expect(clampZoom(0.1)).toBe(0.5);
  expect(clampZoom(1.04)).toBe(1);
  // Steps of a tenth survive: the buttons move 1 → 1.1 → 1.2, not back to 1.
  expect([clampZoom(1 + 0.1), clampZoom(1.1 + 0.1), clampZoom(1 - 0.1)]).toEqual([1.1, 1.2, 0.9]);
  expect(clampZoom(Number('x'))).toBe(1);
});
