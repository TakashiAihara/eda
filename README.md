# eda

Mind map you grow one node at a time with an AI that can only suggest.

- The AI (a Claude Code session) can read the map and suggest **one** node or **one** change at a time. It cannot write.
- You adopt, rewrite-then-adopt, or reject each suggestion in the browser.
- You talk to the same Claude Code session from the map screen; your messages reach it as channel events.
- Nodes carry URLs, a note, and links to kaneo tasks.

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

## Keys (on the map, as in XMind)

| Key | Action |
|---|---|
| Tab | add a child |
| Enter / Shift+Enter | add a sibling after / before |
| F2 / Space | edit the node's text |
| Delete / Backspace | delete the node |
| ← → ↑ ↓ | parent / first child / previous / next sibling |
| + (or =) / - | expand / collapse |
| F6 / Shift+F6 | drill down to the node / back up one level (view only, not saved) |
| Ctrl+= (or Ctrl++) / Ctrl+- / Ctrl+0 | zoom the map in / out / reset (also the buttons at the top right; Cmd on macOS) |
| ? | the key sheet |

Suggested nodes appear translucent: click to adopt, ✕ to reject. Each main topic (a child of the root) gets its own colour, kept when topics are added or removed; nodes adopted from an AI suggestion carry a ✦ mark.

## Files

A map is a directory:

- `eda.json` — the source of truth, written only by `eda serve`
- `map.md` — nested-bullet export (opens in Markmap / Obsidian). Edits you make here are not applied; they show up as candidates and the file is restored.

## Config

- `~/.config/eda/config.json`: `{ "kaneo": { "host": "https://kaneo.example" } }` — enables task links. `EDA_KANEO_HOST` overrides.
- `EDA_HOME` (default `~/.eda`): token and running-instance registry.

## Develop

```bash
bun test
bun run typecheck
```
