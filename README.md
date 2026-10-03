# eda

Mind map you grow one node at a time with an AI that can only suggest.

Status: early development. No release yet; the file format and the MCP tools may still change.

- The AI (a Claude Code session) can read the map and suggest nodes or changes, **one** per suggestion, with up to three waiting at a time. It cannot write.
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

- `~/.config/eda/config.json`: `{ "kaneo": { "host": "https://kaneo.example", "workspace": "<workspace id>" }, "spawn": { "command": ["spawn-task", "{number}", "--project", "{project}", "--repo", "{repo}"] } }` — `host` enables task links (`EDA_KANEO_HOST` overrides it), `workspace` is where the project picker looks, and `spawn.command` is the argv 「session に依頼」 runs with `{number} {project} {repo} {workspace} {task}` filled in; no command, no button.
- `KANEO_API_KEY`: the kaneo API key. Without it the create / dispatch / status features are off and the browser shows only the URL link.
- `EDA_HOME` (default `~/.eda`): token and running-instance registry.

## Security

- One token per host (`$EDA_HOME/token`), shared by every map on that host and by the MCP server. Anyone holding a map URL can open every map running on that host, and act as the AI side too.
- `eda serve` binds `0.0.0.0` and speaks plain HTTP: the map is reachable from the whole LAN, and the token travels unencrypted. Pass `--host 127.0.0.1` to keep it local, and do not expose the port to the internet.
- To revoke the token, stop the running maps, delete `$EDA_HOME/token`, and start them again; a new one is created.

## Contributing

Issues and pull requests are welcome. One rule is the point of the tool and is not up for change: each AI suggestion is one node or one change, a session has at most three waiting, and the AI cannot write; only the person adopts. Changes that let the AI write to the map, adopt on its own, or send many nodes in one suggestion will not be merged.

## Develop

```bash
bunx playwright install --only-shell chromium   # once: test/ui.test.ts drives the map in headless Chromium
bun test
bun run typecheck
```
