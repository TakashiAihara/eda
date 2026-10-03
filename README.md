# eda

Mind map you grow one node at a time with an AI that can only suggest.

- The AI (a Claude Code session) can read the map and suggest **one** node or **one** change at a time. It cannot write.
- You adopt, rewrite-then-adopt, or reject each suggestion in the browser.
- You talk to the same Claude Code session from the map screen; your messages reach it as channel events.
- Nodes carry URLs, a note, links to kaneo tasks, and markers (priority 1–3, doing / done, flag, star, question) that only you set.

Design: `docs/design/0001-v1.md`. Terms: `docs/glossary.md`.

## Install

```bash
git clone https://github.com/TakashiAihara/eda && cd eda && bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/eda
```

## Use

```bash
eda serve ~/maps/trip --title "Trip plan"   # prints {"url": "http://<lan-ip>:<port>/#t=<token>", ...}
eda list                                     # running maps
```

Register the MCP server with Claude Code (user scope) and start Claude Code with the channel loaded:

```bash
claude mcp add -s user eda -- eda mcp
claude --dangerously-load-development-channels server:eda
```

Inside the session, say what you want to think about; the session runs `eda serve` and gives you the URL. A session started with `CLAUDE_CODE_SESSION_ID` is recorded in the map, and `claude --resume <id>` brings you back to it.

In the node panel, 「タスクにする」 turns the node into a kaneo task and 「session に依頼」 hands a linked task to the configured command; kaneo's status comes back on the node's task tag.

## Keys (on the map, as in XMind)

| Key | Action |
|---|---|
| Tab | add a child |
| Enter / Shift+Enter | add a sibling after / before |
| F2 / Space | edit the node's text |
| Delete / Backspace | delete the node |
| ← → ↑ ↓ | parent / first child / previous / next sibling |
| + (or =) / - | expand / collapse |
| 1 / 2 / 3 | toggle priority 1 / 2 / 3 |
| d / f | cycle doing → done → none / toggle the flag (star and question are in the node panel) |
| Alt+1 … Alt+9 / Alt+0 | show only that many levels / all levels (view only, not saved) |
| F6 / Shift+F6 | drill down to the node / back up one level (view only, not saved) |
| Ctrl+= (or Ctrl++) / Ctrl+- / Ctrl+0 | zoom the map in / out / reset (also the buttons at the top right; Cmd on macOS) |
| ? | the key sheet |

Suggested nodes have a dashed border: click to adopt, ✕ to reject. Nodes adopted from an AI suggestion carry a ✦ mark.

## Files

A map is a directory:

- `eda.json` — the source of truth, written only by `eda serve`
- `map.md` — nested-bullet export (opens in Markmap / Obsidian). Edits you make here are not applied; they show up as candidates and the file is restored.

## Config

- `~/.config/eda/config.json`: `{ "kaneo": { "host": "https://kaneo.example", "workspace": "<workspace id>" }, "spawn": { "command": ["spawn-task", "{number}", "--project", "{project}", "--repo", "{repo}"] } }` — `host` enables task links (`EDA_KANEO_HOST` overrides it), `workspace` is where the project picker looks, and `spawn.command` is the argv 「session に依頼」 runs with `{number} {project} {repo} {workspace} {task}` filled in; no command, no button. Reading a task's status is a `GET` on the task, so the status on the node needs the host and the key only; 「タスクにする」 and the project picker also need `workspace`.
- `KANEO_API_KEY`: the kaneo API key. Without it the create / dispatch / status features are off and the browser shows only the URL link. It has to be in `eda serve`'s own environment (start eda under `inf-run`, or export the key first): the dispatched command inherits that environment.
- `EDA_HOME` (default `~/.eda`): token and running-instance registry.

## Develop

```bash
bun test
bun run typecheck
```
