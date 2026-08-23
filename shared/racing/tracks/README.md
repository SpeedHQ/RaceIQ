# Tracks

Track domain owns venue/revision/layout identity, registry projection, track facts, game geometry, detector hints, and runtime asset resolution.

## Source hierarchy

```text
shared/data/tracks/venues/<root-venue>/venue.json
shared/data/tracks/venues/<root-venue>/revisions/<revision-path>/revision.json
shared/data/tracks/venues/<root-venue>/revisions/<revision-path>/tracks/<layout>/metadata.json
```

- Root-only `venuePath` means source revision `current`.
- `current` layout canonical ID stays `<root-venue>/<layout>`.
- Historical canonical ID is `<root-venue>/<revision-path>/<layout>`; revision path may be nested.
- Canonical order is venue, historical revision when present, layout. Never layout/revision.
- Use browser-safe helpers in `configuration.ts` to parse venue paths and build revision/layout asset components. Never hand-split or hand-assemble hierarchy paths.
- Revision imagery belongs beside `revision.json`; layout geometry, guide, and hints belong beside `metadata.json`.
- Shared ACC/TUMFTM geometry remains at root venue `geometry/`.

## Key modules

- Core contracts: `facts.ts`, `geometry.ts`, `keys.ts`, `named-segments.ts`, `segment-label.ts`.
- Identity/path helpers: `configuration.ts`; catalogs: `catalogs/*`.
- Registry and persistence: `registry.ts`, `storage/files.ts`, `storage/meta.ts`, `storage/cache.ts`.
- Geometry: `coords.ts`, `projection.ts`, `path.ts`, `sectors.ts`, `geometry/*`, `recording/*`.
- Curation: `curation/*`; authored guides: `guide/*`; detector hints: `detect-hints.ts`.

## Data split and projection

- `venue.json` owns stable venue root.
- `revision.json` owns source revision identity `{ version: 1, id, name }`. `current` is source-only, not projected venue node; historical revisions reconstruct nested venue nodes.
- Layout `metadata.json` owns layout identity and assignments, optional facts, `geometryByGame`, and verification.
- SQLite `venue_nodes`, `layouts`, `game_tracks`, facts, geometry, and verification rows project these manifests without changing public layout IDs or query semantics.
- `joinSegments` combines shared facts with one game's geometry; `splitSegments` supports editors.
- Every game asset/API path requires `gameId`; never default one.

## Runtime package boundary

- Runtime reads generated `registry.sqlite`, not source manifests or report.
- Runtime includes revision imagery, layout geometry, and `guide.json`.
- Runtime excludes `venue.json`, `revision.json`, `metadata.json`, `detect-hints.json`, registry source, and registry report.
- Root shared ACC/TUMFTM geometry still ships.
- Resolve generated-artifact conflicts through source manifests, then regenerate.

## Browser vs Node boundary

Browser-safe modules include contracts/math plus `configuration.ts` path helpers. Node-only leaves include `registry.ts`, `resolve-name.ts`, `detect-hints.ts`, `storage/*`, file-backed geometry/recording/catalog/guide modules, and source curation writers. Browser code consumes normalized boundary values instead of importing Node leaves.

## Add or extend

- Update facts and per-game fractional geometry through shared authoring APIs; they write matching revision/layout `metadata.json`, then rebuild projection.
- Add catalog mapping only for one-to-one identity.
- Store game files under canonical layout `geometry/<gameId>/`; store revision image files under revision `imagery/`; keep root shared geometry at root.
- Import explicit leaves; this directory has no barrel contract.
- Human verification records content hashes in layout metadata. Generation never stamps verification.
