# Shared data

Checked-in static assets consumed by game, track, setup, and tune loaders.

## Layout

- `setup/` — hardware/setup reference data.
- `tracks/` — curated track metadata, outlines, guides, hints, and verification state.
- `tunes/` — bundled tune catalogs and source metadata.

Source builds resolve this directory through `shared/platform/runtime/data-paths.ts`. Production builds copy its contents into `dist/data` without adding another `data` nesting level. Game adapter CSV files remain under `shared/games` and copy to `dist/data/games`.

Do not hand-edit generated assets. Follow each nested README and owning extraction or curation command.
