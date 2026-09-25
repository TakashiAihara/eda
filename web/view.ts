/** The parts of drawing the map that need no DOM, so they are tested without a browser. */
import type { Node } from '../src/map.ts';

/** The root down to `id`, both ends included; empty when `id` is not under `root`. */
export function pathTo(root: Node, id: string): Node[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const p = pathTo(c, id);
    if (p.length) return [root, ...p];
  }
  return [];
}

/**
 * The selection, or the collapsed ancestor that hides it (XMind moves the selection there).
 * `top` is the drawn root. A drilled-down top shows its children even when collapsed, so
 * its own flag does not hide anything.
 */
export function visibleSelection(top: Node, id: string, topShowsChildren = false): string {
  const p = pathTo(top, id);
  // Gone, or outside the drilled-down branch: the top is what is left to select.
  if (!p.length) return top.id;
  const hidden = p.findIndex((n, i) => n.collapsed && !(i === 0 && topShowsChildren));
  return hidden === -1 || hidden === p.length - 1 ? id : p[hidden]!.id;
}

/**
 * Palette slot of a main topic, from its id rather than its position: inserting or deleting
 * a sibling would otherwise recolour every topic after it. Ids are `n<seq>`, so topics added
 * one after another take consecutive colours.
 * ponytail: neighbours can share a colour (1 in 6); store a colour on the node if that bites.
 */
export function topicColour(id: string): number {
  const n = Number(id.replace(/\D/g, ''));
  return Number.isFinite(n) ? n % 6 : 0;
}

export const clampZoom = (z: number): number => Math.min(2, Math.max(0.5, Math.round((Number.isFinite(z) ? z : 1) * 10) / 10));
