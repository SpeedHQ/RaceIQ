# Setup Engineer flow — implementation task list

Companion checklist for [`setup-engineer-flow-design.md`](./setup-engineer-flow-design.md). Work top-down: **finish + validate Tranche A (core) on real laps before starting F1, import, or the safety net.** Check boxes as they land.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Tranche A — Core (keystone, independently shippable)

### Phase 0 — Migration v30 + schema sync
- [ ] Add migration v30 entry at bottom of `server/db/migrations.ts` (raw SQL, no FK ALTERs)
- [ ] `laps.tuning_excluded INTEGER` (nullable) — column + `server/db/schema.ts` `laps` def
- [ ] `tuning_tests.setup_snapshot TEXT` (nullable JSON) — column + schema.ts + `CreateTuningTestData`/insert in `tuning-test-queries.ts`
- [ ] `tuning_actions` table (`id`, `tuningSessionId`, `kind`, `inversePayload`, `undone`, `createdAt`) + index `idx_tuning_actions_session` + Drizzle def
- [ ] Widen `tuning_tests.status` TS union to include `'deleted'` (no DDL)
- [ ] New `server/db/tuning-action-queries.ts` (`recordAction`, `listActions`, `markUndone`)
- [ ] Verify migration on a DB copy (`.schema`), re-run for idempotency

### Phase 1 — Clean-lap aggregate + consistency
- [ ] Promote `stddevPopulation` + `consistencyRating` from `server/recap.ts` into shared `server/lap-stats.ts`; repoint recap.ts imports
- [ ] New `server/ai/clean-lap-aggregate.ts` with types (`Confidence`, `ConsistencyReport`, `LapBreakdownRow`, `CleanLapAggregate`) re-exported from `setup-engineer-context.ts`
- [ ] `selectCleanLaps()` — valid-only, drop user-excluded, blunder rule `> max(median+1.5·IQR, best·1.02)`, emit `LapBreakdownRow[]`
- [ ] `computeConsistency()` — time-repeatability bands (high/med/low/very-low), soft, not track-scaled
- [ ] `aggregateSymptoms()` — majority-vote lists + median numeric leaves over `TuneSymptoms.aggregate`
- [ ] `loadCleanLapAggregate()` — pool select, `sourceScope`, `<2 clean` single-lap fallback, corner resolve, calls `computeLapConsistencyDelta` (Phase 11)
- [ ] `computeSessionAggregate()` wrapper in `setup-engineer-context.ts`; leave `loadRepresentativeLap`/`computeSessionSymptoms`/`computeSessionTrackConditions` intact
- [ ] `test/clean-lap-aggregate.test.ts` — outlier drop, confidence bands, symptom aggregation

### Phase 2 — Lap→test query for the current run
- [ ] `getLapMetaForTuningTest(testId)` in `server/db/queries.ts` (+ add `tuningTestId` to projection in both selects)
- [ ] Head-test-pool preference + session-baseline fallback with `sourceScope:"session-baseline"` + confidence cap `medium`

### Phase 3 — Deterministic turn workflow + slimmed prompt
- [ ] `gatherPrereqs` composes CONFIDENCE / LAP BREAKDOWN / CONSISTENCY BY CORNER / SYMPTOMS / TRACK CONDITIONS / CURRENT SETUP / VERSION HISTORY from one `loadCleanLapAggregate` call
- [ ] Drop separate `computeSessionTrackConditions` call in the turn
- [ ] Slim `SETUP_ENGINEER_INSTRUCTIONS` — remove per-tool choreography; keep confidence / sufficiency / exclusions / setup-vs-driver rules + immediate-fix bypass
- [ ] New tool `set_lap_excluded(lapId, excluded)` (flips flag, logs action)
- [ ] New tool `compare_lap_consistency(opts?)` (read-only, on-demand deviations)
- [ ] Manual check: inspect injected `gatheredContext` (CopyChatJson) — SYMPTOMS reflects multiple laps

### Phase 11 — Lap-consistency delta (line + inputs) — lands with core
- [ ] Extract shared frames→`{x,z}` helper `shared/lib/lap-path.ts` (PositionX/Z + velocity fallback); repoint `TrackMap`/`AnalyseTrackMap`/`CompareTrackMap`
- [ ] New `server/lap-consistency.ts` `computeLapConsistencyDelta()` — resample by arc-length fraction, per-bin line + brake + throttle spread, roll up to corners, `lowTrust` flags
- [ ] Wire into `loadCleanLapAggregate` (`cornerConsistency`) + the `compare_lap_consistency` tool
- [ ] `test/lap-consistency.test.ts` — identical laps ~0 spread; line offset → lowTrust; early braking → brakeVar lowTrust

### Tranche A gate
- [ ] `cd client && bun run build` (tsc + vite) + `bun run test` green
- [ ] E2E over real routes (ACC): low-consistency lap set → engineer flags confidence, judges sufficiency, names a blunder lap, offers suggest/coach
- [ ] **Validate on real laps that suggestion quality actually improves before starting later tranches**

---

## Tranche B — Additive (any order after core)

### Phase 4 — Multi-base forest (add base / inspiration)
- [ ] `POST /api/tuning-sessions/:id/bases` (guard, `nextFreeLabel`, `parentTestId=null`, optional setHead, chat ack)
- [ ] Generalize `branch_from_version` tool with `asNewRoot?: boolean`
- [ ] Extract setup-picker sub-component out of `NewTuningSessionModal` (reused here + Phase 6)
- [ ] UI "Add base" affordance + per-node "Use as inspiration" in workspace/`VersionGraph`
- [ ] `useAddBase` hook; invalidate session/tests/chat

### Phase 5 — Track-length-aware stint nudge
- [ ] `shared/lap-target.ts` `suggestLapTarget(estLapSec, trackLengthM)` (clamp 1..4)
- [ ] Compute `lapTarget` server-side on session GET, ship on payload
- [ ] Replace hardcoded `/ 3` copy in `TuningSessionWorkspace.tsx:200-202` with `session.lapTarget`; per-run framing
- [ ] `test/lap-target.test.ts` — short→4, long→1, heuristic fallback

### Phase 6 — Add laps from history (Mode B / collect)
- [ ] `GET /api/tuning-sessions/:id/importable-laps` (car+track+game match, not already stamped)
- [ ] `POST /api/tuning-sessions/:id/import-laps` (stamp `tuningSessionId` + optional `tuningTestId`)
- [ ] Import modal — lap multiselect, target selector (branch / baseline), setup-warning banner (ACC/AC-Evo only; suppressed for F1 with match check)
- [ ] `useImportableLaps` + `useImportLaps` hooks
- [ ] Two workspace buttons: Run live test + Add laps from history

### Phase 7 — Manual lap exclusion (UI)
- [ ] `POST /api/laps/:id/tuning-excluded` (set flag, log action)
- [ ] Per-lap "exclude from tuning" toggle in `tune-version-shared.tsx` LapBreakdown + `TestReviewDashboard`; struck-through render
- [ ] `useSetLapExcluded` hook

---

## Tranche C — New game: F1 2025 (own tranche, biggest surface)

### Phase 10 — F1 tuning support
- [ ] Setup source/sink adapter `server/ai/setup-io.ts` (file impl for ACC/AC-Evo; snapshot impl for F1)
- [ ] Base-capture timing: backfill `setup_snapshot` from first lap carrying `f1?.setup` + live "capture current setup" action
- [ ] Route `loadActiveTuningContext` through adapter; lift `acc|ac-evo` hard-reject to allow `f1-2025`
- [ ] `RULES['f1-2025']` in `tune-rules.ts` on the `F1CarSetup` value model — **ranges sourced from `f1-setup-catalog.ts` / bundled f1laps setups.json, not invented**
- [ ] Relax `z.enum(["acc","ac-evo"])` schemas in `tune-routes.ts` to include `f1-2025` where no file needed
- [ ] F1 apply output = advisory diff (no "load file" line) via `buildAppliedChangesMarkdown`
- [ ] F1 "Add base" affordance = "capture current car setup"
- [ ] `test/tune-rules-f1.test.ts` — intent moves right field within range + clamps
- [ ] E2E (f1-2025): create session → capture base → chat reads real setup → apply stores target snapshot + advisory diff → import no-warning + match check

---

## Tranche D — Safety net (delete + undo, ship as a pair)

### Phase 8 — Delete / trash nodes (subtree, reversible)
- [ ] `POST /api/tuning-sessions/:id/tests/:testId/delete` — subtree walk, `status='deleted'`, move head off trashed subtree, log action; restore path
- [ ] AI tool `delete_version(testId)`
- [ ] Filter `status='deleted'` in `listTuningTests`/`/tests` (+ `?includeDeleted=1`); **audit every caller**
- [ ] UI per-node "Delete branch" (subtree confirm) + Trash disclosure + Restore; `useDeleteVersion`/`useRestoreVersion`

### Phase 9 — Action history + undo (user + AI)
- [ ] `recordAction` wired into every writer (apply/branch/add-base/inspire/import/set-head/delete/restore/rename/exclude)
- [ ] `POST /api/tuning-sessions/:id/undo` — inverse per kind, newest-first, idempotent, `undone` flag
- [ ] Undo/delete guard: node with laps/children warns + subtree soft-delete (issue F)
- [ ] AI tool `undo_last_action()`
- [ ] History panel UI + `useTuningHistory`/`useUndo`

### Tranche D gate
- [ ] E2E: delete subtree → undo restores + head back; undo of apply/import/set-head each reverse correctly; newest-first + idempotent

---

## Final
- [ ] Full `bun run test` + client build green
- [ ] Migration idempotency re-verified after all schema-touching phases
