# shared/tracks

Static track assets used by `shared/track` loaders.

## Purpose
- Store canonical facts and per-game geometry snapshots.
- Store shared outlines, boundaries, detector hints, guides, and coverage signatures.

## Top-level map
- `meta/<slug>.json` — game-agnostic facts.
- `detect-hints.json` — optional curve-detection allowances keyed by `<slug>`.
- `verified.json` — manual verification ledger for curation.
- `guides/<slug>.json` — authored guidance and corner callouts.
- `tumftm/<slug>-centerline.csv`, `tumftm/<slug>-boundaries.json` — shared baseline geometry.
- `<gameId>/<slug>-segments.json` and extracted files for game-specific geometry.

Per-game dirs currently present:
- `acc/`, `ac-evo/`, `fm-2023/`, `f1-2025/`.

## File formats
- **meta** (`slug.json`):
  - `{ slug, track, layout, layoutName, name, source?, corners[], straights? }`.
  - Corner fields include number, optional covers, name, optional direction/group.
- **segments** (`<slug>-segments.json`):
  - `{ sectors?: { s1End, s2End }, segments: [{ key, startFrac, endFrac }] }`.
  - Keys are shared-semantics keys from `shared/track/keys.ts` (`t1`, `t10-11`, `s3`).
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
- `<gameId>/*-centerline.csv`, `*-raceline.csv`, and `*-boundaries.json` are generated snapshots of game data. The installed game data read by the matching extractor is authoritative.
- `tumftm/*` is imported baseline geometry from TUMFTM/racetrack-database; retain its source identity when refreshing it.
- `guides/*` and `detect-hints.json` are reviewed, hand-curated inputs. Hints describe detector behavior only and must not carry physical track facts.
- `verified.json` records human review of exact file hashes. Generation must never stamp verification automatically.

## Regeneration
1. Refresh the committed track catalog in `shared/games/<game>/tracks.csv` when game content changes.
2. Run the matching extractor:
   - `bun run extract:tracks:forza`
   - `bun run extract:tracks:f1`
   - `bun run extract:tracks:acc`
   - `bun run extract:tracks:ac-evo`
3. Dry-run alignment with `bun run tracks:segments --track <slug> [--game <gameId>]`.
4. Inspect alignment issues, then persist acceptable output with `bun run tracks:segments --track <slug> --write`. Use `--allow-fuzzy` only after reviewing the reported mismatch.
5. Manually compare facts to the cited circuit source and geometry to a rendered/extracted lap before recording sign-off with `bun run tracks:coverage --verify ...`.
6. Refresh contribution-guide coverage tables with `bun run tracks:coverage --write`.

## Curation expectations
- Preserve the core invariant: facts contain classification and names but no fractions; game geometry contains fractions and keys but no names.
- Keep one canonical slug across `meta/`, per-game assets, guides, detector hints, and verification keys.
- Account for every official turn exactly once and keep turns in racing order. Use `covers` for one physical corner spanning several official numbers.
- Add `optional` or `spans` hints only for demonstrated centerline/detector behavior.
- Do not invent corner names or citations, hand-edit generated fraction ranges, or verify data that was not manually inspected.
