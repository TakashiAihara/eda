# Importing an XMind file

Status: implemented (issue #30).

## Background

- Request (2026-11-01, verbatim): 「xmind 形式から import ってできたりするかな」「作る」
- The person's existing maps are XMind files, in both formats: one from XMind 2020+ (`content.json`, 207 topics) and one from XMind 8 (`content.xml`, 18 topics).

## Decision

- `eda import <file.xmind> <dir> [--sheet <n>]` writes a new map into a directory that holds none; it never touches a running or existing map.
- Every imported node's origin is the person: they wrote it, in XMind.
- What comes over is each topic's title (flattened to one line, as every eda node is) and its attached subtopics.

| XMind | eda |
|---|---|
| sheet | one map; `--sheet` picks it, default 1 |
| title | `text` |
| attached subtopics | children |
| notes, links, markers, folded state, labels, images | dropped |
| floating (detached) topics, relationships, boundaries, summaries | dropped |

- Notes, links, markers and folded state have eda fields, but the person's two files have none of them, so they are not mapped yet. Map them when a file that uses them turns up.

## Other options

- Adding the imported topics to a running map as candidates. A whole map arrives as hundreds of candidates at once, which is the giant map the one-node-at-a-time rule exists to avoid. The decision to keep map.md export-only (2026-10-11) was about hand edits reaching a live map; a new map has no such conflict.
- A zip library. Bun.Archive reads tar only (Bun 1.4.3: `Unrecognized archive format` on a zip); reading the zip directory and `node:zlib` takes about 40 lines, with no dependency.

## Format notes

- A `.xmind` file is a zip. XMind 2020+ writes `content.json` and also a `content.xml` that only says to upgrade, so `content.json` wins when both are there.
- Entries may be stored (method 0, seen in the XMind 2020+ file) or deflated (method 8, seen in the XMind 8 file).
- Zip64 is not read; XMind files are far below its 4 GB threshold.
