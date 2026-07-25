# Auto Tune (ACC + AC-Evo) — Implementation Plan

## Context

RaceIQ already analyzes telemetry and emits *textual* setup advice via the
analyst pipeline (`AnalystOutputSchema.setup[]`). **Auto Tune** goes one step
further: read a driver's stint telemetry + their current setup file, have an LLM
decide *what to change and which direction* (intent layer), then a deterministic
rule engine converts intent → concrete click deltas clamped to per-car safe
ranges, and writes a **new setup JSON straight into the game's Setups folder**
so the user loads it in-game.

Scope now: **ACC first, then AC-Evo** (both write plain JSON setups to
`~/Documents/<game>/Setups/<car>/<track>/`, so we can push directly). AC-Evo's
setup-file JSON shape + Setups-folder location are **unverified** — ship ACC
end-to-end, then validate a real AC-Evo file before enabling it.
Engine = **hybrid**: LLM picks intent, rules clamp values **relative** to the
current setup (see Rules). Ship **one-shot (A)** first; carry a `stintId` +
`setupSnapshot` in the data model so the **guided loop (B)** later is a diff.

Non-goals now: Forza/GT7/F1 write-back, the guided-loop UI, community publishing.

## Architecture

```
getLapById(stintId) ── telemetry ─┐
                                   ├─► tune-symptoms ─► TuneSymptoms
getCorners()/detectCorners() ──────┘                        │
                                                            ▼
current setup JSON (game dir) ──────────► tune-intent (LLM) ─► TuneIntent[]
   (getByPath via setup-schema)                 │                 │
                                                └──► tune-rules ──┘  (clamp/apply)
                                                        │
                                                        ▼  setByPath on clone
                                              tune-writer ─► write setup JSON to game dir
```

Four independently-testable units + schemas + one route + UI reuse.

## Units

### 1. `server/ai/tune-symptoms.ts` (pure)
`telemetryToSymptoms(packets, corners): TuneSymptoms`
- Mirror `buildCornerData` banding (`server/ai/corner-data.ts`): filter packets per
  corner by `DistanceTraveled >= corner.distanceStart && <= corner.distanceEnd`,
  split each corner into entry/mid/exit distance thirds.
- Note: `corner-data.ts` gives per-corner *aggregate* rows, **not** an
  entry/mid/exit split — the mid-phase banding is **new** derivation here (thirds
  by distance), not reuse. If `getCorners` returns `[]`, degrade to whole-lap
  aggregates.
- Per phase derive: balance (front vs rear `TireSlipAngle*` → understeer/oversteer),
  brake lockups (`TireSlipRatio*` spikes under brake), bottoming
  (`frontRideHeight` / `SurfaceRumble*`), tyre pressure/temp deltas vs target
  window (`TirePressure{Front,Rear}{Left,Right}`, brake temp channels).
- Output = compact structured `TuneSymptoms` (per-corner + aggregate), no LLM.

### 2. `server/ai/tune-intent.ts` (LLM)
`buildTunePrompt(symptoms, currentSetup, meta): string` +
`requestTuneIntents(prompt): Promise<TuneIntent[]>`
- Prompt embeds `TuneSymptoms`, current setup rendered via
  `getSchemaForGame(gameId)` field labels, car/track meta.
- Call provider through existing `server/ai/providers.ts`:
  `runOpenAi(prompt, key, model, TuneIntentJsonSchema, "auto_tune")` /
  `runGemini(...)` / `runClaudeCli(...)` (Claude falls back to
  `parseAnalystOutput`-style fence stripping).
- LLM returns **only** `{ path, direction, magnitude, reason }` per change —
  never raw numbers. `path` must be a valid `FieldDef.path`; `direction ∈
  increase|decrease` **only** (drop `adjust` — no clamp semantics);
  `magnitude ∈ small|medium|large` → fixed click counts.
- **Provider caveat:** `runOpenAi`/`runGemini` accept a pluggable schema
  (structured output). `runClaudeCli(prompt, model?)` takes **no schema** (pipe
  mode, ~90s timeout, haiku default) — for v1 **require OpenAI or Gemini** for
  Auto Tune; if Claude CLI is allowed, `parseTuneIntents` must be as defensive as
  `parseAnalystOutput` (fence-strip + slice `{..}`).

### 3. `server/ai/tune-rules.ts` (pure — the safety layer)
`applyIntents(currentSetup, intents, gameId): { setup, changes[] }`
- **Relative clamping (no absolute per-car table).** ACC/AC-Evo click ranges are
  per-car and exist **nowhere** in the codebase (`FieldDef` has `path,label,arity,
  hint?,step?,min?` — **no `max`**, and `step`/`min` are largely unpopulated,
  `setup-schema.ts:9-16,113-121`). So do NOT invent an absolute range DB. Instead:
  - map `magnitude` → a bounded click delta (`small=1, medium=2, large=3`,
    capped by a per-run click budget);
  - apply signed delta to the current integer value read via `getByPath`;
  - **never write a field absent from the source setup JSON** (only nudge fields
    the file already has, relative to their own value) — car-agnostic + safe;
  - `Number.isInteger` gate on every result; drop non-integer/no-op deltas.
- **Array-aware writes:** for `arity` `corners`(4)/`axles`(2), read the array at
  `path`, apply the delta to the targeted index, and write the whole array back —
  never `setByPath(path, scalar)` onto an array (that corrupts it). Use
  `arityLength`/`arityLabels` to index.
- Mutate a **deep clone** of the parsed JSON (`setByPath` overwrites intermediate
  non-objects, so always clone-first — per setup-schema note). Emit `changes[]`
  (`{ path, index?, label, from, to, reason }`) for UI/audit/preview.
- `direction` accepts `increase|decrease` only.

### 4. `server/routes/tune-routes.ts` — new `POST /api/tunes/auto`
Body `{ gameId: "acc"|"ac-evo", stintId, setupFilePath, apply?: boolean }`.
- Resolve base with existing `getSetupsBaseDir(gameId)`.
- Reuse the **path-traversal guard** from `import-file`
  (`realpathSync(absPath)` + `startsWith(realBase + sep)`, `.json` only) for both
  read and write.
- Read current setup (`readFileSync` + `JSON.parse`), run symptoms → intent →
  rules. Return `{ symptoms, changes, preview }`.
- If `apply`, `tune-writer` serializes and writes
  `<car>/<track>/<origName>-autotune.json` under the Setups dir. **Apply the
  tune-routes traversal guard** (`realpathSync` + `startsWith(base+sep)`) to the
  final dest path — do NOT copy the acc-routes install handler, which guards
  nothing. **Back up** original first (copy to `*.bak`). **Collision policy:** if
  target exists, suffix `-autotune-2`, `-3`… (never overwrite). Return
  `{ written, path }`.
- `<car>` folder is ACC's car **slug**, not `carOrdinal` — needs an
  ordinal→slug mapping (verify against `getAccCarName`/car-data during impl; the
  source setup file's own path already encodes car/track, so prefer deriving
  dest from the source file's location rather than re-mapping).
- `tune-writer` = small helper (in tune-routes or `server/ai/tune-writer.ts`):
  `JSON.stringify(setup, null, 2)` + guarded `writeFileSync` + `mkdirSync({recursive})`.

### 5. Schemas — `server/ai/schemas.ts`
Add and export:
- `TuneSymptomsSchema` (per-corner phase balance/lockup/bottoming/pressure).
- `TuneIntentSchema` = `{ path, direction: z.enum(["increase","decrease"]),
  magnitude: z.enum(["small","medium","large"]), reason }`; array wrapper
  `TuneIntentsSchema`. (Do **not** reuse the module-private `DirectionEnum` at
  `schemas.ts:18` — it includes `adjust`, which has no clamp semantics; define a
  fresh 2-value enum.) Add `getTuneIntentJsonSchema()` (`z.toJSONSchema`) mirroring
  `getAnalystJsonSchema()` for structured-output providers.
- `parseTuneIntents(raw)` mirroring `parseAnalystOutput` (fence strip + safeParse).

### 6. UI — reuse, minimal new
- Extend `client/src/components/setup-tune/` with an "Auto Tune" action that
  POSTs `/api/tunes/auto`, shows `changes[]` using existing
  `TuneBar`/`SetupSection` pattern from
  `client/src/components/ai/analysis-display.tsx` (from → to clicks per field),
  then an "Apply to game" button that re-POSTs with `apply:true`.
- No new heavy component; follow `ImportSetupFile.tsx` mutation/hook pattern.

## Reused existing code (do not reinvent)
- `getByPath` / `setByPath` / `getSchemaForGame` / `arityLength` / `arityLabels`
  / `CORNER_LABELS` / `AXLE_LABELS` — `setup-schema.ts`.
- `getSetupsBaseDir(gameId)` + import-file traversal guard — `tune-routes.ts`.
- `getLapById` / `getCorners` — `server/db/queries.ts`; `detectCorners` —
  `server/corner-detection.ts`; per-corner banding — `server/ai/corner-data.ts`.
- `runOpenAi` / `runGemini` / `runClaudeCli` — `server/ai/providers.ts`;
  schema/parse pattern — `getAnalystJsonSchema` / `parseAnalystOutput` in
  `schemas.ts`.
- `TuneBar` / `SetupSection` — `analysis-display.tsx`.

## Data model for future guided loop (B)
Persist per auto-tune run: `{ stintId, gameId, carId, trackId, setupSnapshot (pre),
intents, changes, resultPath, createdAt }`. One-shot ignores history; guided loop
later diffs consecutive `setupSnapshot`s. Store as JSON row (reuse existing
tune/laptimes DB patterns in `server/db/`), no schema churn beyond one table.

## Verification (end-to-end)
1. Unit: `tune-symptoms` against a fixture `TelemetryPacket[]` (use
   `parseRawLapFramesForTest`) — assert understeer/lockup/bottoming detection.
2. Unit: `tune-rules` — feed synthetic intents, assert clamping to min/max/step
   and that the original object is never mutated (clone check).
3. Schema: `parseTuneIntents` round-trips valid + rejects invalid paths.
4. Integration: `POST /api/tunes/auto` (no apply) on a real ACC setup file →
   inspect `changes`/`preview`. Then `apply:true` → confirm new
   `*-autotune.json` under `~/Documents/Assetto Corsa Competizione/Setups/...`,
   `.bak` created, original untouched, path-guard rejects outside-Setups paths.
5. Repeat for AC-Evo (`Assetto Corsa EVO`, includes `AC_EVO_SUSPENSION` fields).
6. Build gate: `tsc -b && vite build` (per project workflow, not Biome).

## Live tuning dashboard (additive — diagnose live, apply between sessions)
Hard constraint: sims accept setup edits only in garage/pits, and ACC/Forza do
**not** expose the active setup in telemetry (only F1 does via
`TelemetryPacket.f1.setup`). So "live tuning" = live **diagnose** + queued tune;
the write/apply stays the between-session action already planned above.

- **Route per game**: add `live-tune.tsx` beside existing `live.tsx` in each game
  dir (`client/src/routes/{acc,f1,fm23,ac-evo}/`), following current
  file-based routing + `Fm23LiveLayout` redirect pattern.
- **Live symptom source**: reuse `server/ws.ts` 10Hz ring buffers
  (`TelemetryHistoryData`: grip/temp/wear/slipAngle/slipRatio/suspension +
  throttle/brake/speed arrays, `GRIP_MAX_SAMPLES=600`). Feed same
  `telemetryToSymptoms()` (from `server/ai/tune-symptoms.ts`) on a rolling
  window instead of a saved stint — no new ingest path. Client already has the
  data via `useTelemetryStore` (`stores/telemetry.ts`); compute symptoms
  client-side from the store, or add a lightweight WS `type:"live-symptoms"`
  message if we want server-side derivation. Prefer client-side first (zero
  server change, reuses store).
- **UI is tuning-focused, NOT a driver-gauge clone**: do not mirror
  `LiveTelemetry`/`ForzaLiveDashboard` (speed/rpm/gear driver layout). This
  screen is a *setup workbench*: primary content = per-corner-phase symptom
  readout (entry/mid/exit understeer·oversteer·lockup·instability) and the
  growing **suggested-tune list** (component, direction, delta, reason). Telemetry
  charts are secondary/supporting only — pull in `GripSparkline`/`TireDiagram`
  where they justify a symptom (e.g. slip-angle balance, tyre-temp spread), not
  as the centerpiece. Card style from `analysis-display.tsx`. No new chart dep.
- **Queued tune**: accumulate intents across the run (debounced/aggregated, not
  per-corner spam), show a running "suggested tune" panel. On pit/session-end
  (detect via existing `_pit`/`IsRaceOn` transitions), enable one-tap Apply that
  calls the same `POST /api/tunes/auto` apply path — no separate write logic.
- Car/track known live every packet (`CarOrdinal`/`TrackOrdinal` →
  `useCarName`/`useTrackName`) so the queued tune targets the right setup file.
- **F1 nuance**: f125 exposes live setup, so its `live-tune.tsx` can show
  current setup values inline (bonus); ACC/Forza show symptoms + queued deltas
  only. Do not block ACC-first shipping on F1 extras.

## Open risk
No per-car click-range data exists anywhere in the codebase, and `FieldDef` has
no `max`. Rather than invent an absolute range DB (unsafe — ranges are per-car),
clamping is **relative**: nudge only fields already present in the source setup
file, by a bounded click budget from their own current value, integer-gated. This
is car-agnostic and cannot write a field the game didn't already expose. AC-Evo
file format is unverified — ACC ships first.
