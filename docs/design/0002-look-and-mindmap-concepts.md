# Look, icons, keys, and what to take from XMind / MindMeister

Status: slice 1 implemented in this PR. Slices 2 and 3 wait on the owner's decisions (judgment queue D-01..D-03).

## Background

- Request (kaneo eda#5, verbatim): 「あとは design と icon か shortcut とか 整えていきたいな。あと xmind や mindmeister のコンセプトとかも取り入れていきたい。」
- v1 draws the tree with grey CSS borders, marks nodes with emoji (🔗 ✓ 📝), and has XMind's editing keys with no way to discover them.
- The rule from v1 stays: the AI cannot write the map and suggests one node at a time. Nothing here adds an MCP tool.

## Conclusion

- Slice 1 (this PR) changes only the browser: branch colours, inline SVG icons, a key sheet, drill-down, and zoom. No field is added to `eda.json`.
- Anything that needs a new field on `Node` (markers, relationships, boundaries) is a later slice, because a field name is a storage format and is the owner's call.

## What XMind / MindMeister have, and where it lands

| Concept | XMind / MindMeister | eda | Needs a new field |
|---|---|---|---|
| Branch colour | each main branch gets a colour its subtree inherits | slice 1 | no (derived from the top-level index) |
| Root as a distinct shape | filled central topic | slice 1 | no |
| Icons instead of text marks | markers / icons | slice 1 for eda's own marks (link, task, note, fold) | no |
| Key sheet | XMind `Ctrl+/` shortcut list | slice 1, `?` | no |
| Drill down / up | XMind `F6` / `Shift+F6` | slice 1, view only | no |
| Zoom | both | slice 1, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` on the map | no |
| Markers (priority, progress, flag) | XMind markers, MindMeister task status | slice 2 | yes (D-01) |
| Collapse to level N | XMind "expand to level" | slice 2 | depends on D-02 |
| Relationship (a line between any two nodes) | both | slice 3 | yes (D-03) |
| Boundary (a box around siblings) | XMind | slice 3 | yes (D-03) |
| Balanced layout (branches on both sides of the root) | MindMeister default, XMind "Mind Map" structure | not planned; the right-hand tree matches the `map.md` outline order | no |

## Slice 1 details

- Branch colour: the n-th child of the drawn root (the map's root, or the drilled-down node) takes palette colour `n mod 6`; its connectors and node borders use it. The palette has light and dark values. Colours are recomputed when drilling down, so they follow position, not identity.
- Provenance moves from a coloured border to a ✦ icon, since border colour now means the branch.
- The root is a filled pill in the accent colour.
- Icons are a handful of inline SVG paths in `web/icons.ts` (no icon package): link, task, note, AI, expand, collapse, close. A favicon is an inline SVG data URL.
- Drill-down shows the selected node as the root of the view. It is not stored: a reload shows the whole map. `Shift+F6` or the breadcrumb goes back up.
- Zoom is a CSS `zoom` on the tree, kept per browser in `localStorage`.
- The key sheet lists every key eda handles; it is generated from the same table the key handler reads, so the two cannot drift.
