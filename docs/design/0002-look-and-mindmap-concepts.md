# Look, icons, keys, and what to take from XMind / MindMeister

Status: slice 1 implemented (PR #8); its branch colours removed again (PR #11). Slice 2 (markers, level limit) implemented after the owner's decisions: a fixed marker set, the level limit view-only. Slice 3 (relationships, boundaries) is wanted but deferred (kaneo eda#42).

## Background

- Request (kaneo eda#5, verbatim): 「あとは design と icon か shortcut とか 整えていきたいな。あと xmind や mindmeister のコンセプトとかも取り入れていきたい。」
- v1 draws the tree with grey CSS borders, marks nodes with emoji (🔗 ✓ 📝), and has XMind's editing keys with no way to discover them.
- The rule from v1 stays: the AI cannot write the map and suggests one node at a time. Nothing here adds an MCP tool.

## Conclusion

- Slice 1 (PR #8) changes only the browser: inline SVG icons, a key sheet, drill-down, and zoom. Branch colours came in with it and were taken out again (see below). No field is added to `eda.json`.
- Anything that needs a new field on `Node` (markers, relationships, boundaries) is a later slice, because a field name is a storage format and is the owner's call.

## What XMind / MindMeister have, and where it lands

| Concept | XMind / MindMeister | eda | Needs a new field |
|---|---|---|---|
| Branch colour | each main topic gets a colour its subtree inherits | tried in slice 1, removed | no |
| Root as a distinct shape | filled central topic | slice 1 | no |
| Icons instead of text marks | markers / icons | slice 1 for eda's own marks (link, task, note, fold) | no |
| Key sheet | XMind's shortcut list (Help menu) | slice 1, `?` | no |
| Drill down / up | XMind `F6` / `Shift+F6` | slice 1, view only | no |
| Zoom | both | slice 1, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` on the map | no |
| Markers (priority, progress, flag) | XMind markers, MindMeister task status | slice 2 | yes: `Node.markers` |
| Collapse to level N | XMind "expand to level" | slice 2, view only | no |
| Relationship (a line between any two nodes) | both | slice 3, deferred | yes |
| Boundary (a box around siblings) | XMind | slice 3, deferred | yes |
| Balanced layout (branches on both sides of the root) | MindMeister default, XMind "Mind Map" structure | not planned; the right-hand tree matches the `map.md` outline order | no |

## Slice 1 details

- Branch colours were removed after trying them (PR #11; the owner's words: 「うーん、色が順不同になったり、それによって視認性が下がるぐらいなら 矢印に色をつけるというのをやめたいです。」). No colouring rule without a stored colour fits: by position, an insert recolours every later topic; by creation rank, the colours do not follow the order on screen and a delete shifts them; by raw id, they repeat at random (4 topics: 72% chance two match). Storing one per node was the remaining option and was not taken. Lines, node borders and fold buttons are grey; the fold buttons use `--muted` (about 5.2:1 on a card), since `--line` is 1.6–1.9:1 against the page and card backgrounds, too faint for a control.
- Provenance is a ✦ icon rather than a coloured border.
- The root is a filled pill in the accent colour.
- Icons are inline SVG paths in `web/icons.ts` (no icon package): link, task, note, AI, plus, minus, close, keyboard. AI is eda's own, keyboard is drawn after Lucide's, and the rest are Feather's; `web/ICONS-LICENSE` is Lucide's licence file, which holds both the ISC and the Feather MIT notice. A favicon is an inline SVG data URL.
- Drill-down (F6, or the button in the node panel) shows the selected node as the root of the view, with its children even when it is collapsed; those children become the main topics. It is not stored: a reload shows the whole map. `Shift+F6` or the breadcrumb goes back up. The drilled-down top cannot be deleted (like the root) or folded (it always shows its children). A leaf cannot be drilled into. Suggestions outside the drilled branch are not drawn on the map; the sidebar's candidate list still shows every one.
- Zoom is a CSS `zoom` on the tree, kept in `localStorage`, which is per origin: `eda serve --port 0` gets a new port, so a new zoom, each run. Ctrl+= / Ctrl+- / Ctrl+0 zoom the map only while focus is on the map (which is most of the time); elsewhere they stay the browser's page zoom. Page zoom stays reachable through the browser menu and Ctrl+wheel.
- The key sheet is a native dialog: closed, it returns focus to what opened it. Opened from the map (`?`, or a mouse click on the header button, which does not take focus) the map keeps its keys; opened by keyboard from the header button, focus goes back to that button, as for any dialog.
- The selection follows focus on a node (Tab from the header, Shift+Tab from the sidebar, or a mouse press), so the keys act on the highlighted node. Tab from the header lands on the view's top, which then becomes the selection.
- The key sheet is generated from the table the key handler reads, so it lists exactly the keys the map takes. The README's key table is a hand-kept copy.
- Narrow screens (720px and below) stack the sidebar under the map instead of a 380px column beside it. The header shows the map directory's last segment; the full path is its tooltip.

## Slice 2 details

- Markers are a fixed set, `priority-1..3`, `doing`, `done`, `flag`, `star`, `question`, stored as `Node.markers` (absent when empty, in that fixed order). Free labels were not taken: they would grow into a second task tracker next to the kaneo links.
- One priority and one progress state at a time: setting one replaces the other of its group, as in XMind. Flag, star and question are independent.
- Only a person sets markers (`POST /api/nodes/:id/markers`). The AI reads them in `read_map`; no MCP tool sets them, and an AI edit that carries a `markers` field is not read. The route shares the one token with the AI side, like adoption does (the known limit in 0001, issue #2). The AI does not suggest markers either (D-01).
- The route takes `{ marker, on }` rather than toggling, so a doubled key press or a retried request lands on the same state, like the URL and task routes.
- Keys: 1 / 2 / 3 toggle a priority, `d` cycles doing → done → none, `f` toggles the flag. Star and question are buttons in the node panel, which has a toggle for every marker.
- `map.md` does not carry markers: it stays a plain outline that Markmap and Obsidian open.
- The level limit (Alt+1..9, Alt+0 for all) hides what is below that level under the drawn root without touching `collapsed`, so it is not saved and a reload shows every level.
- While it hides something (a node or a waiting suggestion), the header says so with a way back, and a node at the cut gets a button with the hidden count that shows every level again rather than saving a fold. A node already collapsed there keeps its own fold button.
- Suggestions below the limit are not drawn on the map; the cut button counts those directly under its node, and the sidebar lists them all.
- At the limit, `+` shows one more level (and unfolds the node if it was collapsed), and `-` does nothing: there is no fold on screen to save.
- Tab on a node at the limit shows one more level for the new child. Adding a child from the node panel or adopting from the sidebar does not raise the limit; the new node is counted on the cut button.
- With Alt, digit keys are read from their position (`KeyboardEvent.code`), since Option+1 on a Mac types ¡.
- Known limit: Chrome and Firefox on Linux keep Alt+1..8 for switching tabs, which the page may not be able to take (not checked on a Linux desktop; macOS and Windows use other keys for tabs).
