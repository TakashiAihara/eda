import { expect, test } from 'bun:test';
import type { Node } from '../src/map.ts';
import { clampZoom, pathTo, topicColour, visibleSelection } from '../web/view.ts';

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
});

test('topic colour follows the id, not the position', () => {
  expect(topicColour('n7')).toBe(1);
  expect(topicColour('n12')).toBe(0);
  expect([2, 3, 4, 5, 6, 7].map((i) => topicColour(`n${i}`))).toEqual([2, 3, 4, 5, 0, 1]);
});

test('zoom is clamped and rounded, and junk falls back to 1', () => {
  expect(clampZoom(10)).toBe(2);
  expect(clampZoom(0.1)).toBe(0.5);
  expect(clampZoom(1.04)).toBe(1);
  expect(clampZoom(Number('x'))).toBe(1);
});
