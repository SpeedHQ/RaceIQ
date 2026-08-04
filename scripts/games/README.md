# Game data scripts

## Purpose

Installed-game readers and format-specific extraction tools. Each game folder owns discovery, binary parsing policy, and generated catalog or geometry outputs for that simulator.

## Game map

| Directory | Scope |
| --- | --- |
| [`ac-evo/`](ac-evo/) | KSPKG car, track, geometry, and setup-range extraction |
| [`acc/`](acc/) | ACC track extraction and boundary-derived centerlines |
| [`f1-2025/`](f1-2025/) | ERP inspection, AI spline parsing, track extraction, and track imports |
| [`fm-2023/`](fm-2023/) | Forza Motorsport track and car-dimension extraction |

## Boundaries

- Game installation discovery and archive details remain game-specific.
- Binary parser helpers must not execute work at import time.
- Keep checked-in outputs under owning `shared/` data directories.
- Use canonical game IDs in paths and generated metadata.
- Review generated diffs before commit; extractors must not silently overwrite curated track facts.

See each game README for prerequisites, commands, and output paths.
