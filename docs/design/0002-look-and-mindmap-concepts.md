# Look, icons, keys, and what to take from XMind / MindMeister

Status: slice 1 implemented (PR #8). Slices 2 and 3 wait on the owner's decisions: which markers to store, whether collapse-to-level is saved, whether relationships and boundaries come in at all.

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
| Branch colour | each main topic gets a colour its subtree inherits | slice 1 | no (derived from the topics' creation order) |
| Root as a distinct shape | filled central topic | slice 1 | no |
| Icons instead of text marks | markers / icons | slice 1 for eda's own marks (link, task, note, fold) | no |
| Key sheet | XMind's shortcut list (Help menu) | slice 1, `?` | no |
| Drill down / up | XMind `F6` / `Shift+F6` | slice 1, view only | no |
| Zoom | both | slice 1, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` on the map | no |
| Markers (priority, progress, flag) | XMind markers, MindMeister task status | slice 2 | yes (D-01) |
| Collapse to level N | XMind "expand to level" | slice 2 | depends on D-02 |
| Relationship (a line between any two nodes) | both | slice 3 | yes (D-03) |
| Boundary (a box around siblings) | XMind | slice 3 | yes (D-03) |
| Balanced layout (branches on both sides of the root) | MindMeister default, XMind "Mind Map" structure | not planned; the right-hand tree matches the `map.md` outline order | no |

## Slice 1 details

- Topic colour: a main topic (a child of the drawn root, the map's root or the drilled-down node) takes palette colour `rank mod 6`, where rank orders the topics by the number in their ids (creation order); its connectors and node borders use it. Not the position, which recolours every later topic on an insert; not the raw id, whose sequence is shared with suggestions and chat, so colours would repeat at random (4 topics: 72% chance two match). By rank, the first six always differ and an insert recolours nothing; deleting a topic shifts the ones created after it. Storing a colour per node is the upgrade if that matters. The palette has light and dark values.
- Provenance moves from a coloured border to a ✦ icon, since border colour now means the branch.
- The root is a filled pill in the accent colour.
- Icons are inline SVG paths in `web/icons.ts` (no icon package): link, task, note, AI, plus, minus, close, keyboard. AI is eda's own, keyboard is drawn after Lucide's, and the rest are Feather's; `web/ICONS-LICENSE` is Lucide's licence file, which holds both the ISC and the Feather MIT notice. A favicon is an inline SVG data URL.
- Drill-down (F6, or the button in the node panel) shows the selected node as the root of the view, with its children even when it is collapsed; those children become the main topics and are coloured afresh. It is not stored: a reload shows the whole map. `Shift+F6` or the breadcrumb goes back up. The drilled-down top cannot be deleted (like the root) or folded (it always shows its children). A leaf cannot be drilled into. Suggestions outside the drilled branch are not drawn on the map; the sidebar's candidate list still shows every one.
- Zoom is a CSS `zoom` on the tree, kept in `localStorage`, which is per origin: `eda serve --port 0` gets a new port, so a new zoom, each run. Ctrl+= / Ctrl+- / Ctrl+0 zoom the map only while focus is on the map (which is most of the time); elsewhere they stay the browser's page zoom. Page zoom stays reachable through the browser menu and Ctrl+wheel.
- The key sheet is a native dialog: closed, it returns focus to what opened it. Opened from the map (`?`, or a mouse click on the header button, which does not take focus) the map keeps its keys; opened by keyboard from the header button, focus goes back to that button, as for any dialog.
- The keys act on the focused node when Tab has put focus on one that is not selected.
- The key sheet is generated from the table the key handler reads, so it lists exactly the keys the map takes. The README's key table is a hand-kept copy.
- Narrow screens (720px and below) stack the sidebar under the map instead of a 380px column beside it. The header shows the map directory's last segment; the full path is its tooltip.
