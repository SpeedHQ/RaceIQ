# Game data scripts

## Purpose

Installed-game extraction tools have been removed. Remaining parsers and curated game-data utilities are documented in each game folder.

## Remaining utilities

| Directory | Scope |
| --- | --- |
| [`f1-2025/`](f1-2025/) | ERP readers and AI spline parsing |

- Game installation discovery and archive details remain game-specific.
- Binary parser helpers must not execute work at import time.
- Keep checked-in outputs under owning `shared/` data directories.
- Use canonical game IDs in paths and generated metadata.
- Review generated diffs before commit; extractors must not silently overwrite curated track facts.

See each game README for prerequisites, commands, and output paths.
