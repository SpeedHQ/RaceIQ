# Track data

Static track assets used by `shared/racing/tracks` loaders.

## Purpose
- Store canonical facts and per-game geometry snapshots.
- Store shared outlines, boundaries, detector hints, guides, and coverage signatures.

## Top-level map
- `meta/<slug>.json` — game-agnostic facts.
- `detect-hints.json` — optional curve-detection allowances keyed by `<slug>`.
- `verified.json` — manual verification ledger for curation.
- `guides/<slug>.json` — authored guidance and corner callouts.
- `tumftm/<slug>-centerline.csv`, `tumftm/<slug>-boundaries.json` — shared baseline geometry.
- `<gameId>/<slug>-segments.json` and shared game-specific geometry files.

ACC source SVGs live at `packages/game-acc/assets/tracks/`; LMU catalog SVGs live at `packages/game-lmu/assets/tracks/`. Their runtime loaders resolve these package-owned assets through `gameAssetsDir`; SVG paths in LMU's catalog remain relative to the game asset root.

## File formats
- **meta** (`slug.json`):
  - `{ slug, track, layout, layoutName, name, source?, corners[], straights? }`.
  - Corner fields include number, optional covers, name, optional direction/group.
- **segments** (`<slug>-segments.json`):
  - `{ sectors?: { s1End, s2End }, segments: [{ key, startFrac, endFrac }] }`.
  - Keys are shared-semantics keys from `shared/racing/tracks/keys.ts` (`t1`, `t10-11`, `s3`).
- **centerline/raceline CSV**:
  - header `x,z`, one point per row.
- **boundaries JSON**:
  - `leftEdge` and `rightEdge` point arrays, plus source-specific metadata such as `centerLine`, `pitLane`, `coordSystem`, `altitude`, `waypoints`, or `aligned`.
- **detect hints**:
  - `{ [slug]: { [turnNumber]: { spans?, optional? } } }`.
- **guide JSON**:
  - `{ id, locale, character, sources, corners[], priorityCorners }`.
- **verified ledger**:
  - `{ path: { hash, date, by?, note? } }` keyed by repository-relative asset path.

## Sources of truth
- `meta/<slug>.json` is authoritative for physical track identity, corner numbering/names, groups, and named straights. Its `source` field must cite the real-world claim.
- Game-specific geometry is committed catalog data.
- `tumftm/*` is imported baseline geometry from TUMFTM/racetrack-database; retain its source identity when refreshing it.
- `guides/*` and `detect-hints.json` are reviewed, hand-curated inputs. Hints describe detector behavior only and must not carry physical track facts.
- `verified.json` records human review of exact file hashes. Generation must never stamp verification automatically.

## Maintenance

Curate geometry updates manually. Use `bun run tracks:segments` to regenerate segment mappings from bundled geometry, and `bun run tracks:coverage` to inspect coverage.

## Curation expectations
- Preserve the core invariant: facts contain classification and names but no fractions; game geometry contains fractions and keys but no names.
- Keep one canonical slug across `meta/`, per-game assets, guides, detector hints, and verification keys.
- Account for every official turn exactly once and keep turns in racing order. Use `covers` for one physical corner spanning several official numbers.
- Add `optional` or `spans` hints only for demonstrated centerline/detector behavior.
- Do not invent corner names or citations, hand-edit generated fraction ranges, or verify data that was not manually inspected.
