# Tooling

Deterministic release-note parsing, rendering, and pull-request validation.

## Modules

- `sections.ts` owns release section order and heading parsing.
- `render.ts` renders public changelog sections and omits internal notes.
- `validation.ts` checks whether a pull request changes `## Unreleased`.

`CHANGELOG.md` is source of truth. `packages/tooling-release/src/release/generate-release-note.ts` generates release artifacts; `packages/tooling-release/src/release/check-changelog.ts` runs validation. Keep these leaves pure string transformations with no filesystem, process, or Git access.

Import explicit leaves such as `@raceiq/tooling-release/tooling/render`; do not add a barrel.
