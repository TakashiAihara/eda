# Glossary

## Words that collide

- **suggestion** vs **candidate**: a *suggestion* is what an AI proposed through MCP (`source.by = ai`). A *candidate* is anything waiting in the candidate list, which in maps saved before #5 also includes hand edits of `map.md` (`source.by = md-edit`). Every suggestion is a candidate; not every candidate is a suggestion. Both are `Suggestion` records in `eda.json`.
- **map** vs **map.md**: the *map* is the tree held in `eda.json` by the server. `map.md` is an export of it, rewritten at start and on every save and never read back.
- **session**: a Claude Code session (its `CLAUDE_CODE_SESSION_ID`) or, once 0005 lands, an ACP session eda opened with an agent (key `acp-<id>`); never a browser session. Say *ACP session* when only the second is meant. An ACP session also has the agent's own `sessionId`, which is not the key eda uses.

## Terms

| Term | Meaning | Where it lives |
|---|---|---|
| map directory | One map: `eda.json` + `map.md` | the `<dir>` given to `eda serve` |
| node | One line of the map. Has id, text, children, note, URLs, task links, origin | `Node` in `src/map.ts` |
| origin | Who put a node or URL there: `human`, `ai` (adopted suggestion, with session/model), `md-edit` (adopted hand edit of map.md, in maps saved before #5) | `Origin` |
| add suggestion | "put this one node under that node" | `Suggestion` with `kind: add` |
| edit suggestion | "change this node's text and/or attach these URLs" | `Suggestion` with `kind: edit` |
| adopt | A person accepts a candidate, optionally after rewriting its text/URLs | `POST /api/suggestions/:id/accept` |
| pending slot | Up to `MAX_PENDING` (3) AI suggestions per session wait at a time | `suggest()` |
| task link | A kaneo task stored as workspace/project/task ids | `TaskLink` |
| instance | A running `eda serve`, registered so the MCP server can find it | `~/.eda/instances/<pid>.json` |
| marker | One of a fixed set on a node: priority-1..3, doing, done, flag, star, question. A priority and a progress state each exclude the others of their group. Set by a person only; the AI reads them | `Node.markers`, `MARKERS` / `setMarker` in `src/map.ts` |
| level limit | Showing only N levels under the drawn root (XMind's expand-to-level, Alt+1..9). Browser-only, never writes `collapsed` | `levels` in `web/app.ts` |
| drill-down | Showing one node as the root of the view (XMind F6). Browser-only; a reload shows the whole map | `drilled` in `web/app.ts` |
| main topic | A child of the drawn root (XMind's term), drawn a little larger than the nodes below it | `.node.topic` in `web/style.css` |
| channel | Claude Code's MCP push (`notifications/claude/channel`) that delivers the person's chat to the session | `src/mcp.ts` |
| agent | A program `eda serve` starts and speaks ACP to (`devin acp`, `opencode acp`, …), the second way in next to the channel. Proposed | `docs/design/0005-acp-agent.md` |
