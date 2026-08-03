# Runtime data paths

Shared path resolver for bundled data and writable user artifacts.

## Purpose
- Centralize runtime location assumptions for bundled static data and writable track artifacts.
- Keep module code consistent between source runs and compiled binary runs.

## Module contract
- `IS_COMPILED`: boolean from `sourceDir` shape (`/$bunfs` or `~BUN`).
- `SHARED_DIR`: read-only data root.
  - compiled: `<exe dir>/data`
  - source: `<repo>/shared`
- `USER_TRACKS_DIR`: writable user data root.
  - compiled: `<APPDATA>/RaceIQ/userdata`
  - source: `<DATA_DIR>/userdata` when `DATA_DIR` is set, otherwise `<repo>/data/userdata`

## Browser vs Node boundary
- `data-paths.ts` is Node-only: it imports `node:os`, `node:path`, and `node:url`, and reads process/executable environment.
- Browser code should receive resolved resources from its application data boundary.

## Dependency direction
- `shared/platform/runtime/data-paths.ts` is a foundational leaf.
- Filesystem-backed catalog, track, and guide loaders consume it for physical path resolution.

## Add/extend safely
- Do not hardcode repository or executable-relative data paths elsewhere; consume `SHARED_DIR` and `USER_TRACKS_DIR`.
- Add any new bundled or writable root here before loaders consume it.
