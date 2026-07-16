# RaceIQ Setup Engineer → Setup IQ Parity: Implementation Plan

Target: bring RaceIQ's "Setup Engineer" (ACC + AC-Evo) to parity with Coach Dave
Delta's "Setup IQ", then exceed it. Grounded in a read of the current pipeline:
`server/corner-detection.ts` → `server/ai/tune-symptoms.ts` (`telemetryToSymptoms`)
→ `server/ai/tune-intent.ts` (`requestTuneIntents`, LLM) → `server/ai/tune-rules.ts`
(`applyIntents` + per-game component tables) → `server/ai/tune-writer.ts`
(`writeSetupFile`, guarded under the Setups base dir), exposed via
`POST /api/tunes/auto` and consumed by `useAutoTune` / `useSetupEngineer` /
`AutoTunePanel.tsx` (live overwrite of `RaceIQ_auto_setup.json`).

Status: planning doc for WIP branch `worktree-auto-tune-session-picker`. Not on main.

---

## 1. Gap analysis — Setup IQ capability vs RaceIQ today

| Setup IQ capability | RaceIQ today | Gap |
|---|---|---|
| Pick starting setup, drive laps | `useSetupFiles` + `GET /api/tunes/setup-files`, base-setup picker | exists |
| One-button Autotune → new setup file | `POST /api/tunes/auto` + `applyToFile`; live auto-apply overwrites `RaceIQ_auto_setup.json` | Partial — flow exists but LLM-dependent and produces `-autotune` files, not versions |
| Under/oversteer detection per corner, per phase | `telemetryToSymptoms`: entry/mid/exit balance from front-vs-rear `TireSlipAngle*`, lockup, bottoming, ACC pressure deltas; `distanceFrac` per corner | Partial — no slow/high-speed banding, no spin/snap/wheelspin/cause attribution |
| Slow vs high-speed corner classification driving different fixes | `detectCorners` returns only `distanceStart/End`; symptoms have no speed band | missing |
| Documented rules mapping symptom → setup field | `knownComponents` tables exist but *selection* of components is LLM-only; no ride-height/rake entries | deterministic symptom→intent engine missing; rules coverage thin |
| Steering/speed trace with under/oversteer regions highlighted per corner | uplot charts exist (`TelemetryChart.tsx`, `analyse/AnalyseTelemetryChart.tsx`) but Tune view has no trace chart | missing (the signature view) |
| "Detail" button: input traces + track position | `SectorMap.tsx` draws track from stored positions; no per-lap trace drill-in on the tune route | missing |
| Setup versions v1/v2/… + lap-time delta per stint | `writeSetupFile` auto-increments names; no DB version/stint lineage, no delta UI | missing |
| Driver free-text feel input | none | missing (coordinator requirement) |
| Works without cloud ML | LLM required for intent step; user's local model 400s | deterministic path missing |

---

## 2. Phased roadmap

### Phase 1 — Deterministic autotune + setup versioning ("one button → patched setup, provably")
Goal: press Autotune, get `MySetup v2.json` written from a deterministic rules table, no LLM required.

**Server**
- **New `server/ai/tune-recommend.ts`** — deterministic `symptomsToIntents(symptoms, gameId, options): TuneIntent[]`. Pure function, same `{component, direction, magnitude}` shape `applyIntents` consumes, so `tune-rules.ts` and `tune-writer.ts` are untouched. Rules table in §4d. Unit-testable (`test/tune-recommend.test.ts`).
- **`server/ai/tune-symptoms.ts`** — add `speedBand: "slow" | "medium" | "fast"` and `minSpeedKph` to `CornerSymptom`. Requires `detectCorners` to also return `minSpeed`/`apexIndex` per `Corner` (it already computes `smoothSpeed`; record the min inside each corner span — no detection behavior change).
- **`server/routes/tune-routes.ts`** — extend `AutoTuneSchema` with `engine?: "rules" | "llm"` (default `"rules"`) and `versionOf?: string`. Rules path calls `symptomsToIntents` synchronously; LLM path keeps `requestTuneIntents` as opt-in second opinion.
- **Versioned filenames** — extend `writeSetupFile` with a version mode: source `Base.json` → `Base v2.json`, `v3`, … (parse trailing ` v<N>`). Keep `overwrite` path for `RaceIQ_auto_setup` live mode.
- **DB: setup versions** — new `setupVersions` table in `server/db/schema.ts` + hand-rolled migration in `server/db/migrations.ts`: `id, gameId, trackName, carModel, sourcePath, filePath, version, parentVersionId, createdAt, stintLapIds (json), appliedChanges (json), engine, driverNotes, setupJson`.

**Client**
- `SetupEngineer.tsx`: default Recommend to the deterministic engine; render `applied` diffs (old → new per field, from `AppliedChange`) + source symptoms ("T4 slow-speed entry understeer → Front ARB −1"). "Save as v2" via `applyToFile` version mode.

Ships: one-button, LLM-free autotune with versioned files and an explainable change list.

### Phase 2 — Detection library expansion (underpins everything; see §4e)
- **`shared/types.ts`** — extend `TuneIssueKind` with `spin | snap-oversteer | power-oversteer | entry-oversteer | wheelspin | tc-active | abs-active` (last two ACC-only, gated on electronics fields).
- **`server/ai/tune-symptoms.ts`** — new per-corner detectors (constants co-located with `BALANCE_THRESHOLD` etc.): spin, snap/countersteer, throttle-on vs lift-off oversteer cause, exit wheelspin. `PhaseSymptom` gains `cause?: "throttle" | "brake" | "lift"` and `events: string[]`.
- **`server/ai/tune-issues.ts`** — surface new kinds in `symptomsToIssues` (per-lap) and `detectLiveIssues` (live transients).
- **`server/ai/tune-recommend.ts`** — extend the rules table with new symptom rows (§4d).
- Tests: golden-lap fixtures asserting event detection.

### Phase 3 — Input-trace "Detail" view + under/oversteer highlighting (signature visual)
- **Server**: `GET /api/tunes/lap-trace/:lapId` returning decimated (~1–2k pts) arrays (distance, speed, `Steer`, `Accel`, `Brake`) + `corners[]` (with `speedBand`) + `issues[]` with `distanceFrac` spans. Add `distanceFracStart/End` to `PhaseSymptom` so the client shades regions.
- **Client**: `client/src/components/tunes/TuneTraceDetail.tsx` — uplot multi-series (x = distance): speed / steering / throttle+brake; corner bands T1..Tn; red = oversteer, blue = understeer spans; hover-scrub publishes a distance fraction consumed by `SectorMap.tsx` position marker (shared cursor state).
- **Route**: add `view=detail` to `?session=&lap=&view=`; "Detail" button in `TuneReviewDashboard.tsx`.

### Phase 4 — Stint/version comparison + iterate loop
- **Server**: `GET /api/tunes/versions?gameId&trackName&carModel` reading `setupVersions` joined with lap times (laps→version by timestamp window + manual reassignment fallback). Best/median lap per version, delta vs parent.
- **Client**: `SetupVersionsPanel.tsx` — v1/v2/v3 list with lap deltas, applied changes, driver notes; click → overlay two stints' traces in `TuneTraceDetail`. Reuse comparison infra (`server/comparison.ts`, `compareAnalyses`).

### Phase 5 — Driver feel comments (coordinator requirement; can ride with Phase 1/2; see §4f)

### Phase 6 — Polish / exceed parity
- Live one-button flow: `AutoTunePanel` live gains the comment box + "v(N) written — reload setup in pit" toast via WS.
- Rake/ride-height, diff, bumpstop rules coverage completion per car class.
- Optional LLM "explain" pass: LLM writes rationale over deterministic intents (never chooses numbers).

---

## 3. Conventions compliance (CLAUDE.md)
- All symptom/rule computation server-side; client renders compact JSON. Live events via WS (`detectLiveIssues` → `server/ws.ts`), not polling.
- New endpoints on existing Hono routers with `zValidator`; client via typed Hono RPC hooks; `gameId` via context/body `GameIdSchema`; no dynamic imports; new tables via hand-rolled migrations.
- Every setup write goes through `writeSetupFile`'s realpath-guarded Setups base dir.

---

## 4. Detailed designs

### (a) Slow vs high-speed corner classification
- `detectCorners` records `minSpeedKph` (min smoothed speed within the corner span) and `apexDistance`.
- Classification in `tune-symptoms.ts`: `slow < 100 kph`, `medium 100–160`, `fast > 160` (exported constants `SLOW_CORNER_KPH`, `FAST_CORNER_KPH`; adapter-overridable like `steeringRange`, since AC-Evo road cars vs ACC GT3 differ). Optionally track-relative percentiles later.
- `TuneSymptoms.aggregate` gains banded rollups (`understeerCorners → { slow, fast }`); keep flat arrays for back-compat until migrated.

### (b) Detail view
Server-decimated trace endpoint; uplot chart with shaded symptom regions via `distanceFracStart/End`; shared hover-distance state syncs a position dot on `SectorMap.tsx`. Throttle/brake from `Accel`/`Brake` (0–255, normalize server-side); steering from `Steer` (signed int8, normalize by adapter `steeringRange`).

### (c) Setup versioning + stint comparison
- Filename ` v<N>` + `setupVersions` table as source of truth (filenames alone are fragile). Version row created on every successful write, including live overwrites (snapshot `appliedChanges` + full setup JSON so history survives overwrites).
- Lap↔version association: laps whose start falls after a version's `createdAt` and before the next; manual reassignment allowed.
- Delta computed server-side: best & median lap per version, delta vs parent.

### (d) Deterministic rules table (`server/ai/tune-recommend.ts`)
`Array<{ when: SymptomPredicate; intent: {component, direction, magnitude}; rationale: string; games: GameId[] }>`. Components must exist in `knownComponents` (`tune-rules.ts`) — extend that table where noted.

Current `tune-rules.ts` components (verified):
- ACC: Front/Rear Anti-Roll Bar, Brake Bias, Front Wing (splitter), Rear Wing, Front/Rear Tyre Pressure FL/FR/RL/RR.
- AC-Evo: Front/Rear Anti-Roll Bar, Brake Bias, Front Wing, Rear Wing.
- NOT yet present (needed for transcript rules): ride height / rake, diff preload, bumpstop, dampers, TC/ABS. These rules `skip` safely until the component tables gain the paths.

Initial matrix (transcript-aligned + GT3 doctrine):

| Symptom (band/phase/cause) | ACC change | AC-Evo change |
|---|---|---|
| Slow understeer (entry/mid) | Front ARB −1; **increase rake** rear ride +1 / front −1 (new paths — verify vs real ACC setup) | front ARB / ride-height equivalents |
| Slow oversteer / too much rotation (mid) | Rear ARB −1 | rear ARB |
| Fast understeer | Rear wing −1 or front splitter +1 | wing/aero |
| Fast oversteer | Rear wing +1; rear ride −1 (reduce rake) | wing |
| Entry oversteer, cause brake/lift | Brake bias fwd +0.5; diff preload − (new) | brake bias |
| Exit power-oversteer / wheelspin | Diff on-throttle −, rear ARB −, TC +1 if exposed (new) | rear ARB |
| Snap oversteer (any) | Rear ARB −, rear rebound softer (new), (fast) rear wing + | rear ARB |
| Spin (repeated) | escalate dominant oversteer rule ×1 magnitude | same |
| Brake lockup (exists) | Brake bias toward unaffected axle; ABS +1 if exposed | brake bias |
| Bottoming (exists) | Ride height + / bumpstop rate + (new) | ride height |
| Pressure deltas (exists) | `tyrePressure` per wheel | n/a until AC-Evo targets known |

Conflict resolution: score symptoms by frequency × magnitude across the stint; apply top N=3 intents per run; never emit opposing intents on the same component (net them). **LLM stays optional** (`engine:"llm"` keeps `requestTuneIntents`); deterministic engine is default (local model 400s).

### (e) Detection library expansion — signals, thresholds, kinds, rule hooks
Fields verified in `shared/types.ts`: `AngularVelocityY` (yaw rate), `Yaw/Pitch/Roll`, `VelocityX/Y/Z`, `Speed`, `Steer` (±127, center via adapter), `Accel`/`Brake` (0–255), `TireSlipAngle*`, `TireSlipRatio*`, `NormSuspensionTravel*`; ACC physics also exposes runtime `tc`/`abs`.

| Detection | Signals & threshold sketch | Per-lap? | Live? | New kind | Rules hook |
|---|---|---|---|---|---|
| Spin / near-spin | rear `TireSlipAngle` > `SPIN_SLIP` (~0.35 rad) > `SPIN_MS` (300ms) or \|`AngularVelocityY`\| > `SPIN_YAW_RATE` (~1.2 rad/s) with speed loss > 30% | yes | yes (crit) | `spin` | escalate oversteer ×1 |
| Snap oversteer + countersteer | steering-rate reversal against corner dir, \|dSteer/dt\| > `COUNTERSTEER_RATE` (~400 units/s) while rear slip > front by 2×`BALANCE_THRESHOLD` | yes | yes (warn) | `snap-oversteer` | rear ARB −, rear rebound −, (fast) rear wing + |
| Power vs entry oversteer (cause) | at onset: `Accel`/255 > 0.5 → throttle; `brakeFrac` > `BRAKE_ON` → brake; both low + speed falling → lift. → `PhaseSymptom.cause` | yes | no (enrich) | `power-oversteer`, `entry-oversteer` | diff/on-throttle vs brake-bias/preload |
| Exit wheelspin | rear `TireSlipRatio` > `WHEELSPIN_RATIO` (~0.12) while `Accel`/255 > 0.6 in exit, front normal | yes | yes (info) | `wheelspin` | diff on-throttle −, TC +, rear ARB − |
| TC/ABS engagement (ACC) | runtime `tc`/`abs` > 0 for > X% of corner | yes | yes | `tc-active`, `abs-active` | informational; suppresses wheelspin/lockup rules |

Steering rate uses `TimestampMS` deltas; smooth `Steer` with `rollingAverage` (window ~5) before differentiating to avoid int8 quantization noise. Kerb-strike deferred (overlaps bottoming).

### (f) Driver feel comments
- **UI**: optional multiline "What does the car feel like?" above Recommend in `SetupEngineerControls`; compact single-line variant in `AutoTunePanel` live (persists across laps until cleared). Placeholders: "loose on entry", "understeer in slow hairpins".
- **Wire**: `driverNotes?: string` (max ~500) on `AutoTuneSchema` + `useAutoTune` payload; thread through `useSetupEngineer`.
- **Deterministic use (primary)**: keyword/phrase matcher in `tune-recommend.ts` maps notes to symptom hints `{balance, band?, phase?}`. Hints **bias, never override, physics**: agreeing with a detected symptom bumps its score/magnitude one step; unsupported hint adds at most one `small` intent flagged "driver-reported (unconfirmed by telemetry)"; contradictions surface as a note ("you reported oversteer; telemetry shows entry understeer at T3/T7").
- **LLM use**: when `engine:"llm"`, append notes verbatim to a labelled "Driver feedback" section of `buildTunePrompt`.
- **Persistence**: store on the `setupVersions` row (`driverNotes` column) so version history shows what the driver felt each stint.

---

## 5. Open questions & risks
1. ACC/AC-Evo setup JSON coverage — ride height, diff preload, bumpstops, TC/ABS paths must be verified against real setup files per car class. Missing paths already `skip` safely; ship rules incrementally.
2. Click-step semantics vs physical units differ per car; magnitudes may need per-car scaling.
3. Lap↔version association heuristic can mislabel if the driver doesn't load the new file; manual reassignment or explicit "started stint on vN".
4. Slow/fast thresholds — fixed kph vs track-relative percentiles; validate on AC-Evo road cars.
5. Driver-notes matcher: keywords (deterministic) vs local-LLM parse (unreliable) — keywords first.
6. LMU not supported; F1 has its own catalog (`server/ai/f1-setup-catalog.ts`) — out of scope.
7. Comment persistence — per-version (planned) or also per-corner annotations later.
8. AC-Evo telemetry fidelity — confirm `TireSlipRatio`/`AngularVelocityY` populated (corner detection only just fixed there).

## 6. Recommended first PR (smallest demonstrable slice)
"Deterministic recommend + speed bands": (1) `detectCorners` returns `minSpeed`; (2) `speedBand` on `CornerSymptom`; (3) new `server/ai/tune-recommend.ts` with ~8 rules covering today's symptoms (under/oversteer × slow/fast × phase, lockup, bottoming, pressure); (4) `engine:"rules"` default in `POST /api/tunes/auto` + `driverNotes` pass-through; (5) `SetupEngineer.tsx` applied-change list with rationales; (6) unit tests on a recorded ac-evo lap fixture. No schema migration, no new UI surface — working, explainable, LLM-free one-button autotune immediately; versioning table and Detail view follow in the next two PRs.
