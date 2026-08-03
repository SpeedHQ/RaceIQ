# Release notes

Shared changelog parsing, rendering, and pull-request validation rules.

## Modules

- `sections.ts` defines release section order, release-heading parsing, and the parsed entry contract.
- `render.ts` extracts public `Breaking`, `Features`, and `Fixes` sections, omits `Internal`, and renders current or historical releases.
- `validation.ts` checks whether a pull request adds a bullet under `## Unreleased`.

## Source of truth and generation

`CHANGELOG.md` is the source of truth. `scripts/generate-release-note.ts` reads it and regenerates `releasenote.md` plus `releasenotes.md`; generated output must not become an independent editing surface. `scripts/check-changelog.ts` imports `validation.ts` for the pull-request check.

## Runtime boundary and dependencies

Shared modules are pure string transformations with no Node APIs, so they are browser-safe. Filesystem, process, and Git operations belong to the Bun scripts. Dependency direction runs from `shared/release-notes` into scripts or application consumers, never from shared parsing into those environments.

## Extending release-note rules

- Update `RELEASE_SECTION_ORDER` before teaching renderers about another public section.
- Keep parsing and validation functions deterministic and independent of filesystem state.
- Preserve the distinction between public sections and `Internal` notes.
- Import explicit leaf modules such as `shared/release-notes/render`; do not add a barrel.
