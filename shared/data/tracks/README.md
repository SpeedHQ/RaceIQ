# Track data

Static registry source, generated runtime projection, and shippable track assets used by `shared/racing/tracks`.

## Hierarchy and identity

```text
venues/<root-venue>/venue.json
venues/<root-venue>/revisions/<revision-path>/revision.json
venues/<root-venue>/revisions/<revision-path>/tracks/<layout>/metadata.json
```

- `venue.json` identifies the stable physical venue root and may include normalized general metadata with source provenance.
- `revision.json` has `{ version: 1, id: <revision-path>, name }`.
- `current` is source-only default revision. Current layout ID is `<root-venue>/<layout>`; do not add `/current/`.
- Historical layout ID includes its revision: `<root-venue>/<revision-path>/<layout>`. Example: `monza/2010/grand-prix`; nested revision example: `monza/historical/2011/grand-prix`.
- Layout ID order is always venue, optional historical revision, layout. Never layout then revision.
- `current` does not create a projected venue node. Historical revision documents reconstruct existing nested venue nodes.

## Asset ownership

- Revision-scoped imagery: `venues/<root-venue>/revisions/<revision-path>/imagery/`.
- Layout structural source: `tracks/<layout>/metadata.json`, with assignments, optional facts, `geometryByGame`, and verification.
- Layout-local assets: `tracks/<layout>/geometry/<gameId>/`, `guide.json`, and optional `detect-hints.json`.
  - Every game-scoped asset needs explicit `gameId`; never infer/default one.
  - iRacing source layers live at `geometry/iracing/official/{active,start-finish,turns,pit-road}.svg`.
- Shared root geometry is exceptional and ACC-only: `venues/<root-venue>/geometry/acc/`. Do not move it into a revision or layout.
- `registry.sqlite` projects source, including root venue metadata, for runtime; `registry-report.json` is the generated audit output.

## Data formats

- Venue metadata requires `venueType`, `location`, `country`, and provenance. Real venues carry a latitude/longitude pair and IANA `timeZone`; fictional venues deliberately carry neither.
- Centerline/raceline CSV: header `x,z`, one point each row.
- Boundaries JSON: `leftEdge` and `rightEdge`, plus source metadata such as `centerLine`, `pitLane`, `coordSystem`, `altitude`, `waypoints`, or `aligned`.
- Detect hints: `{ [turnNumber]: { spans?, optional? } }`.
- Guide JSON: `{ id, locale, character, sources, corners[], priorityCorners }`.
- Segment keys from `shared/racing/tracks/keys.ts`: turns `t1`, `t10-11`; straights `s3`.

## Source and runtime boundary

- Venue, revision, and layout manifests are editable source authority. Authoring APIs update source, then regenerate `registry.sqlite` and `registry-report.json`.
- Never edit generated artifacts or export SQLite into source.
- Runtime ships `registry.sqlite` plus revision imagery, layout geometry, and guides. It excludes `venue.json`, `revision.json`, `metadata.json`, `detect-hints.json`, and registry report/source files.
- Merge generated-artifact conflicts through source manifests, then run `bun run tracks:registry`.
- `<gameId>/{centerline,raceline,boundaries}.*` files are extractor snapshots. Installed-game data is authoritative when refreshing them.
- `<gameId>/legacy-{centerline,boundaries}.*` files are imported baselines stored under one canonical owning game layout; FM 2023 owns shared layouts when available, otherwise F1 2025.
- Sepang has no current game assignment; its legacy baseline is staged under `geometry/fm-2023/` and remains unreachable until the registry assigns that layout.

## Regeneration

1. Refresh `shared/games/<game>/tracks.csv`.
2. Run matching extractor: `bun run extract:tracks:forza`, `bun run extract:tracks:f1`, `bun run extract:tracks:acc`, or `bun run extract:tracks:ac-evo`.
3. Inspect alignment: `bun run tracks:segments --track <slug> [--game <gameId>]`.
4. Persist reviewed source: `bun run tracks:segments --track <slug> --write`; use `--allow-fuzzy` only after review.
5. Compare facts and geometry to cited circuit sources before human `bun run tracks:coverage --verify ...`.
6. Regenerate registry and coverage tables after source changes.

## Curation rules

- One canonical layout identity joins metadata, game assignments, assets, guides, hints, and runtime projection.
- Keep facts, `geometryByGame`, and verification in one layout `metadata.json`; omit uncurated optional sections.
- Account for each official turn once, in racing order; use `covers` for one physical corner spanning official numbers.
- Add hint `optional` or `spans` only for demonstrated detector behavior.
- Do not invent corner names/citations or mutate generated projection.
