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
eda import plan.xmind ~/maps/plan [--sheet 2]  # a new map from an XMind file, then eda serve it
```

`eda import` reads XMind 2020 and later (`content.json`) and XMind 8 (`content.xml`). It takes each topic's text and its attached subtopics; notes, links, markers, labels, images, floating topics and relationships are left behind, and it prints how many of each. It only creates a map: a directory that is not empty is refused, and a topic with no title stops the import.

Register the MCP server with Claude Code (user scope) and start Claude Code with the channel loaded:

```bash
claude mcp add -s user eda -- eda mcp
claude --dangerously-load-development-channels server:eda
```

Inside the session, say what you want to think about; the session runs `eda serve` and gives you the URL. A session started with `CLAUDE_CODE_SESSION_ID` is recorded in the map, and `claude --resume <id>` brings you back to it. A map the session started stops within 5 s of that session's Claude Code process ending, whether it ran as the session's background shell or was detached (it finds the process through `~/.claude/sessions/<pid>.json`, or `$CLAUDE_CONFIG_DIR/sessions`). A map started outside a session, or for a session whose process it cannot find, stays up until you stop it.

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
- `map.md` — nested-bullet export (opens in Markmap / Obsidian). eda rewrites it at start and on every save (a chat line or an AI suggestion is a save too) and never reads it, so edits you make here are overwritten without notice. Upgrading from a version that read map.md back: hand edits made while eda was stopped are overwritten at the next start, not offered. A directory with a `map.md` but no `eda.json` is refused at start.

## Config

- `~/.config/eda/config.json`: `{ "kaneo": { "host": "https://kaneo.example", "workspace": "<workspace id>" }, "spawn": { "command": ["spawn-task", "{number}", "--project", "{project}", "--repo", "{repo}"] } }` — `host` enables task links (`EDA_KANEO_HOST` overrides it), `workspace` is where the project picker looks, `keyCommand` (optional) is an argv that prints the kaneo API key, and `spawn.command` is the argv 「session に依頼」 runs with `{number} {project} {repo} {workspace} {task}` filled in; no command, no button. Reading a task's status is a `GET` on the task, so the status on the node needs the host and the key only; 「タスクにする」 and the project picker also need `workspace`.
- `KANEO_API_KEY`: the kaneo API key. When it is not set (or empty), eda runs `kaneo.keyCommand` once at start (no shell; the command itself is killed after 15 s, children it leaves are not) and uses the single line it prints, e.g. `"keyCommand": ["secret-tool", "lookup", "service", "kaneo"]`; the command's own stderr is not shown. With neither, the create / dispatch / status features are off and the browser shows only the URL link; when the command fails they are off too, and eda's stderr says why in one line. The dispatched command inherits `eda serve`'s environment, so a key read through `keyCommand` is not in it: a command that needs the key fetches it itself (`spawn-task` does).
- `EDA_HOME` (default `~/.eda`): the two tokens and the running-instance registry.

## Security

- Two tokens per host, each shared by every map on that host. `$EDA_HOME/token` is the person's (the browser's): it opens every route except `/api/ai/*`. `$EDA_HOME/ai-token` is the MCP server's: it opens only `/api/ai/*` (read the map, suggest, reply). Anyone holding a map URL can open every map running on that host.
- What the split buys: the MCP server's process holds a credential that cannot adopt, delete or edit, so a fault in it, or a future MCP server that runs elsewhere, does not carry the person's power. It does not stop a Claude Code session with a shell under the same OS user: it can read `$EDA_HOME/token`, and when it starts the map (as the MCP instructions ask) it sees the person's token in the URL `eda serve` prints.
- The `x-eda-session` header is taken as sent: any holder of `ai-token` can act as any session (use its suggestion slots, mark its messages delivered).
- `eda serve` binds `0.0.0.0` and speaks plain HTTP: the map is reachable from the whole LAN, and the token travels unencrypted. Pass `--host 127.0.0.1` to keep it local, and do not expose the port to the internet.
- To revoke a token, stop the running maps, delete `$EDA_HOME/token` or `$EDA_HOME/ai-token`, and start them again; a new one is created. Running MCP servers read `ai-token` on every call, so they pick up a new one without a restart.
- Upgrading from the one-token version, in this order: stop every running `eda serve`; restart the Claude Code sessions, so their `eda mcp` is the new one (an old one reads `$EDA_HOME/token` on every call and would pick up a new person token too); check that no `eda mcp` from before is left (`ps -eo lstart,args | grep '[e]da mcp'` lists only ones started after the restart); delete `$EDA_HOME/token`, so the token the old MCP servers held stops working; start the maps again and open the new URL. An `eda serve` still running from before refuses the new MCP server's calls, and the MCP tools name it.

## Contributing

Issues and pull requests are welcome. One rule is the point of the tool and is not up for change: each AI suggestion is one node or one change, a session has at most three waiting, and the AI cannot write; only the person adopts. Changes that let the AI write to the map, adopt on its own, or send many nodes in one suggestion will not be merged.

## Develop

```bash
bunx playwright install --only-shell chromium   # once: test/ui.test.ts drives the map in headless Chromium
bun test
bun run typecheck
```
