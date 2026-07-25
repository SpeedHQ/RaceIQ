# Setup Engineer flow — implementation task list

Companion checklist for [`setup-engineer-flow-design.md`](./setup-engineer-flow-design.md). Work top-down: **finish + validate Tranche A (core) on real laps before starting F1, import, or the safety net.** Check boxes as they land.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Tranche A — Core (keystone, independently shippable)

### Phase 0 — Migration v30 + schema sync
- [x] Add migration v30 entry at bottom of `server/db/migrations.ts` (raw SQL, no FK ALTERs)
- [x] `laps.tuning_excluded INTEGER` (nullable) — column + `server/db/schema.ts` `laps` def
- [x] `tuning_tests.setup_snapshot TEXT` (nullable JSON) — column + schema.ts + `CreateTuningTestData`/insert in `tuning-test-queries.ts`
- [x] `tuning_actions` table (`id`, `tuningSessionId`, `kind`, `inversePayload`, `undone`, `createdAt`) + index `idx_tuning_actions_session` + Drizzle def
- [x] Widen `tuning_tests.status` TS union to include `'deleted'` (no DDL)
- [x] New `server/db/tuning-action-queries.ts` (`recordAction`, `listActions`, `markUndone`)
- [x] Verify migration on a DB copy (`.schema`), re-run for idempotency

### Phase 1 — Clean-lap aggregate + consistency
- [x] Promote `stddevPopulation` + `consistencyRating` from `server/recap.ts` into shared `server/lap-stats.ts`; repoint recap.ts imports
- [x] New `server/ai/clean-lap-aggregate.ts` with types (`Confidence`, `ConsistencyReport`, `LapBreakdownRow`, `CleanLapAggregate`) re-exported from `setup-engineer-context.ts`
- [x] `selectCleanLaps()` — valid-only, drop user-excluded, blunder rule `> max(median+1.5·IQR, best·1.02)`, emit `LapBreakdownRow[]`
- [x] `computeConsistency()` — time-repeatability bands (high/med/low/very-low), soft, not track-scaled
- [x] `aggregateSymptoms()` — majority-vote lists + median numeric leaves over `TuneSymptoms.aggregate`
- [x] `loadCleanLapAggregate()` — pool select, `sourceScope`, `<2 clean` single-lap fallback, corner resolve, calls `computeLapConsistencyDelta` (Phase 11)
- [x] `computeSessionAggregate()` wrapper in `setup-engineer-context.ts`; leave `loadRepresentativeLap`/`computeSessionSymptoms`/`computeSessionTrackConditions` intact
- [x] `test/clean-lap-aggregate.test.ts` — outlier drop, confidence bands, symptom aggregation

### Phase 2 — Lap→test query for the current run
- [x] `getLapMetaForTuningTest(testId)` in `server/db/queries.ts` (+ add `tuningTestId` to projection in both selects)
- [x] Head-test-pool preference + session-baseline fallback with `sourceScope:"session-baseline"` + confidence cap `medium`

### Phase 3 — Deterministic turn workflow + slimmed prompt
- [x] `gatherPrereqs` composes CONFIDENCE / LAP BREAKDOWN / CONSISTENCY BY CORNER / SYMPTOMS / TRACK CONDITIONS / CURRENT SETUP / VERSION HISTORY from one `loadCleanLapAggregate` call
- [x] Drop separate `computeSessionTrackConditions` call in the turn
- [x] Slim `SETUP_ENGINEER_INSTRUCTIONS` — remove per-tool choreography; keep confidence / sufficiency / exclusions / setup-vs-driver rules + immediate-fix bypass
- [x] New tool `set_lap_excluded(lapId, excluded)` (flips flag, logs action)
- [x] New tool `compare_lap_consistency(opts?)` (read-only, on-demand deviations)
- [ ] Manual check: inspect injected `gatheredContext` (CopyChatJson) — SYMPTOMS reflects multiple laps _(blocked: turn workflow not wired to a live chat route on this branch)_

### Phase 11 — Lap-consistency delta (line + inputs) — lands with core
- [x] Extract shared frames→`{x,z}` helper `shared/lib/lap-path.ts` (PositionX/Z + velocity fallback); repoint `TrackMap` _(AnalyseTrackMap/CompareTrackMap had no duplicated fallback logic — left as-is)_
- [x] New `server/lap-consistency.ts` `computeLapConsistencyDelta()` — resample by arc-length fraction, per-bin line + brake + throttle spread, roll up to corners, `lowTrust` flags
- [x] Wire into `loadCleanLapAggregate` (`cornerConsistency`) + the `compare_lap_consistency` tool
- [x] `test/lap-consistency.test.ts` — identical laps ~0 spread; line offset → lowTrust; early braking → brakeVar lowTrust

### Tranche A gate
- [x] `cd client && bun run build` (tsc + vite) + `bun run test` green _(in-scope clean; pre-existing unrelated failures remain: Fuji track-guide test, `@ai-sdk/provider-utils` missing dep)_
- [ ] E2E over real routes (ACC): low-consistency lap set → engineer flags confidence, judges sufficiency, names a blunder lap, offers suggest/coach _(blocked: turn workflow not wired to a live chat route on this branch)_
- [ ] **Validate on real laps that suggestion quality actually improves before starting later tranches** _(human-in-the-loop)_

---

## Tranche B — Additive (any order after core)

### Phase 4 — Multi-base forest (add base / inspiration)
- [x] `POST /api/tuning-sessions/:id/bases` (guard, `nextFreeLabel`, `parentTestId=null`, optional setHead, chat ack)
- [x] Generalize `branch_from_version` tool with `asNewRoot?: boolean`
- [x] Extract setup-picker sub-component out of `NewTuningSessionModal` (reused here + Phase 6)
- [x] UI "Add base" affordance + per-node "Use as inspiration" in workspace/`VersionGraph`
- [x] `useAddBase` hook; invalidate session/tests/chat

### Phase 5 — Track-length-aware stint nudge
- [x] `shared/lap-target.ts` `suggestLapTarget(estLapSec, trackLengthM)` (clamp 1..4)
- [x] Compute `lapTarget` server-side on session GET, ship on payload
- [x] Replace hardcoded `/ 3` copy in `TuningSessionWorkspace.tsx:200-202` with `session.lapTarget`; per-run framing
- [x] `test/lap-target.test.ts` — short→4, long→1, heuristic fallback

### Phase 6 — Add laps from history (Mode B / collect)
- [x] `GET /api/tuning-sessions/:id/importable-laps` (car+track+game match, not already stamped)
- [x] `POST /api/tuning-sessions/:id/import-laps` (stamp `tuningSessionId` + optional `tuningTestId`)
- [x] Import modal — lap multiselect, target selector (branch / baseline), setup-warning banner (ACC/AC-Evo only; suppressed for F1 with match check)
- [x] `useImportableLaps` + `useImportLaps` hooks
- [x] Two workspace buttons: Run live test + Add laps from history

### Phase 7 — Manual lap exclusion (UI)
- [x] `POST /api/laps/:id/tuning-excluded` (set flag, log action)
- [x] Per-lap "exclude from tuning" toggle in `tune-version-shared.tsx` LapBreakdown + `TestReviewDashboard`; struck-through render
- [x] `useSetLapExcluded` hook

---

## Tranche C — New game: F1 2025 (own tranche, biggest surface)

### Phase 10 — F1 tuning support
- [x] Setup source/sink adapter `server/ai/setup-io.ts` (file impl for ACC/AC-Evo; snapshot impl for F1)
- [x] Base-capture timing: backfill `setup_snapshot` from first lap carrying `f1?.setup` + live "capture current setup" action
- [x] Route `loadActiveTuningContext` through adapter; lift `acc|ac-evo` hard-reject to allow `f1-2025`
- [x] `RULES['f1-2025']` in `tune-rules.ts` on the `F1CarSetup` value model — **ranges sourced from `f1-setup-catalog.ts` / bundled f1laps setups.json, not invented**
- [x] Relax `z.enum(["acc","ac-evo"])` schemas in `tune-routes.ts` to include `f1-2025` where no file needed
- [x] F1 apply output = advisory diff (no "load file" line) via `buildAppliedChangesMarkdown`
- [x] F1 "Add base" affordance = "capture current car setup"
- [x] `test/tune-rules-f1.test.ts` — intent moves right field within range + clamps
- [ ] E2E (f1-2025): create session → capture base → chat reads real setup → apply stores target snapshot + advisory diff → import no-warning + match check

---

## Tranche D — Safety net (delete + undo, ship as a pair)

### Phase 8 — Delete / trash nodes (subtree, reversible)
- [x] `POST /api/tuning-sessions/:id/tests/:testId/delete` — subtree walk, `status='deleted'`, move head off trashed subtree, log action; restore path
- [x] AI tool `delete_version(testId)`
- [x] Filter `status='deleted'` in `listTuningTests`/`/tests` (+ `?includeDeleted=1`); **audit every caller**
- [x] UI per-node "Delete branch" (subtree confirm) + Trash disclosure + Restore; `useDeleteVersion`/`useRestoreVersion`

### Phase 9 — Action history + undo (user + AI)
- [x] `recordAction` wired into every writer (apply/branch/add-base/inspire/import/set-head/delete/restore/rename/exclude)
- [x] `POST /api/tuning-sessions/:id/undo` — inverse per kind, newest-first, idempotent, `undone` flag
- [x] Undo/delete guard: node with laps/children warns + subtree soft-delete (issue F)
- [x] AI tool `undo_last_action()`
- [x] History panel UI + `useTuningHistory`/`useUndo`

### Tranche D gate
- [x] E2E (unit-tested via `test/tuning-undo.test.ts`): delete subtree → undo restores + head back; undo of set-head reverses correctly; newest-first + idempotent. Manual E2E for apply/branch/add-base/inspire/import inverses via the History panel not separately re-run (same shared `undoLastAction` code path, exercised by the unit tests above).

---

## Final
- [ ] Full `bun run test` + client build green
- [ ] Migration idempotency re-verified after all schema-touching phases
