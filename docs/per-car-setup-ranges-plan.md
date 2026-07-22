# Per-Car Setup Ranges — ACC + AC Evo

## Problem

Tune ranges in `server/ai/tune-rules.ts` (`RULES`) are per-game globals, not per-car:

- **ACC**: single clamp table for all cars. Wrong for many: ARB `0-30` (most GT3s 0-8 clicks), dampers `0-20` (many cars 0-30/40), splitter `0-10` (many cars fixed), diff preload `0-100` (click index, real counts far smaller). Comment in file already admits "may need per-car-class scaling later".
- **AC Evo**: only 5 components, all guessed globals. Ride height/dampers absent. No availability gating — model can suggest wing change on wingless road car.
- Real games: every car has different tunable ranges AND different tunable availability (race cars more options than road cars).

Contrast: F1 2025 table already derives observed min/max from catalog data (`server/ai/f1-setup-catalog.ts`) — that pattern is the model for ACC.

## Goal

Per-car data for both games:
1. **Availability** — which tunables exist for the car (absent = never suggested by AI, hidden/locked in UI).
2. **Range** — min/max/step per tunable per car.

## Data sources (researched)

### AC Evo — extract from game files (exact)

- Per-car physics/setup data: `content/cars/<car>/data/cardata.car` inside `content.kspkg`, protobuf-encoded.
- Repo already has the needed infra:
  - `server/games/ac-evo/kspkg.ts` — `Kspkg` class reads the archive (file table, XOR cipher, path-hash lookup, `findContentKspkg()` probes Steam install paths).
  - `server/games/ac-evo/kspkg-tables.ts` — `decodeProtoMessage()` generic protobuf field walker + `parseCarsTable()` precedent.
- External references if decoding stalls:
  - https://github.com/Nenkai/ACEvo.Package (kspkg CLI; notes protobuf schemas recoverable via protodump against game exe)
  - https://github.com/ntpopgetdope/ace-kspkg (Python extractor; confirms `content\cars\<car>\data\cardata.car` path)
  - https://github.com/sa413x/kspkg-viewer
- **Must run on Windows gaming PC with AC Evo installed** (no `content.kspkg` on the Mac).

### ACC — no extractable source (car data is encrypted `.kunosblob`)

No public per-car ranges dataset exists. Hybrid approach:
1. **Observed ranges** derived from scraped community setups in `shared/tunes/acc/accsetups-com/{track}/{car}.json` (same trick as F1 catalog). Under-reports true range (only values pros used) — treat as floor.
2. **Curated overrides** for known cars (GT3 ARB click counts, fixed splitters, damper click counts) layered on top. Start with popular GT3s.
3. **Availability inference**: field constant across every scraped setup for a car ⇒ likely fixed/unavailable; flag for curation rather than auto-drop.

## Deliverables

### Phase 1 — AC Evo extractor (run on Windows)

`scripts/extract-acevo-setup-ranges.ts` (bun):
1. `findContentKspkg()` to locate archive (accepts explicit path arg too).
2. List entries matching `content/cars/*/data/cardata.car`.
3. For each car: extract, `decodeProtoMessage()`, locate setup-definition section.
   - **First step is exploratory**: add `--dump <carModel>` flag printing the decoded proto field tree for one car so the setup block (item names, min, max, step, presence) can be identified. Iterate on real output.
4. Emit `shared/games/ac-evo/setup-ranges.json`:
   ```json
   {
     "<carModel>": {
       "frontARB":  { "min": 0, "max": 8, "step": 1 },
       "brakeBias": { "min": 47, "max": 68, "step": 0.5 },
       "rearWing":  null            // null / absent key = not tunable on this car
     }
   }
   ```
   Keys use the AC Evo in-memory snapshot field names already used by `RULES["ac-evo"]` (`frontARB`, `rearARB`, `brakeBias`, `frontWing`, `rearWing`, plus whatever else the extraction surfaces — ride height, dampers, pressures, camber, toe...).
5. Commit generated JSON (regeneratable; script is source of truth for format).

### Phase 2 — ACC derivation + curation (runs anywhere)

`scripts/derive-acc-setup-ranges.ts` (bun):
1. Walk `shared/tunes/acc/accsetups-com/*/*.json`, group by carModel.
2. Per car, per setup path (reuse paths from `RULES.acc` + full path list from `shared/setup-schema.ts`): observed min/max across all setups; count distinct values.
3. Emit `shared/tunes/acc/setup-ranges.json`:
   ```json
   {
     "<carModel>": {
       "advancedSetup.aeroBalance.splitter": { "min": 0, "max": 0, "observed": true, "constant": true },
       "advancedSetup.mechanicalBalance.aRBFront": { "min": 0, "max": 8, "observed": true }
     }
   }
   ```
4. `shared/tunes/acc/setup-ranges-overrides.json` — hand-curated, merged over observed at load time. Seed with well-documented GT3s; grow over time.
5. `constant: true` fields surface in a report (script prints table) for curation decisions — do NOT auto-mark unavailable.

### Phase 3 — wiring

1. `server/ai/tune-rules.ts` — DONE (as internal `tableFor(gameId, carModel)` rather than
   an exported `getCarRules`): per-car JSON narrows the existing `RULES` entries; falls back
   to per-game defaults when car (or game data) is unknown. Component `null` for the car ⇒
   dropped from `knownComponents` (intent prompt list) AND rejected by `applyIntents`.
2. Setup engineer / tune routes — DONE: `tune-crud-routes.ts` derives `carModel` from the
   setup path (`<base>/<carModel>/<track>/<file>.json`) and threads it into both
   `requestTuneIntents` and `applyIntents`.
3. Client — DEFERRED: the extracted AC Evo ranges are real-world values keyed by flat
   telemetry-snapshot fields (`brakeBias` %, `frontRideHeight` mm, …), while the client form
   edits the nested Kunos click-index JSON (`advancedSetup.…`, integer clicks). No verified
   click↔real conversion exists, so clamping/hiding client inputs from this data would
   fabricate mappings. Revisit if/when a click-scale table per car is extracted.
4. Tests — DONE: `test/tune-rules.test.ts` covers per-car narrowing against the real
   extracted data (abarth_695_biposto null wings; ferrari_296_gt3 clamps/steps), null-component
   rejection, unknown-car fallback, and ACC ignoring `carModel`. (No ACC fixture — Phase 2
   skipped, ACC stays on global clamps.)

## Order of work (Windows session)

1. Run `bun run scripts/extract-acevo-setup-ranges.ts --dump <someCar>` — inspect proto tree, identify setup block.
2. Finish parser, generate + commit `setup-ranges.json`.
3. Run ACC derivation script, review `constant` report, seed overrides.
4. Wire Phase 3, build (`tsc -b && vite build`), test, push to main.

## Open questions

- AC Evo `cardata.car` proto layout unknown until first dump — parser shape TBD from real data.
- AC Evo carModel key: confirm archive folder name matches `model` in `shared/games/ac-evo/cars.csv` / discovered cars (mapping may be needed).
- ACC carModel naming in accsetups-com scrape vs game carModel ids — verify join key.
- Wet vs dry compound: ACC pressure ranges differ per compound — v1 ignores, note for later.
