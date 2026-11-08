# Tooling

Deterministic release-note parsing, rendering, and pull-request validation.

## Modules

- `sections.ts` owns release section order and heading parsing.
- `render.ts` renders public changelog sections and omits internal notes.
- `validation.ts` checks whether a pull request adds a note to `UNRELEASED.md`, whose category sections need no enclosing heading.

`UNRELEASED.md` is the source of truth for ongoing changes; `CHANGELOG.md` contains released history only. `packages/tooling-release/src/release/generate-release-note.ts` generates the public release artifact; `packages/tooling-release/src/release/check-changelog.ts` runs validation; `packages/tooling-release/src/release/rollover-changelog.ts` moves ongoing notes into released history and resets `UNRELEASED.md`. Keep these leaves pure string transformations with no filesystem, process, or Git access.

Import explicit leaves such as `@raceiq/tooling-release/tooling/render`; do not add a barrel.
