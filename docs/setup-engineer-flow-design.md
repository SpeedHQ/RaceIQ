# Setup Engineer — solidify the tuning-session flow

## Context

RaceIQ's Setup Engineer lets a driver tune a car for a track, run test laps, and get AI setup suggestions. The plumbing exists (sessions, a branch-tree of setup versions, a tool-using Mastra agent that applies changes and forks versions), but the **suggestion quality is fundamentally undermined by one fact**: the AI reads *exactly one lap* — the single fastest valid lap (`loadRepresentativeLap`, `server/ai/setup-engineer-context.ts:143`). It can't see consistency, can't tell a good setup from a lucky lap, and can't distinguish a setup problem from a driver problem.

The user wants the flow solidified around a clear mental model:

- A **session = one car + one track**, persists indefinitely; the user returns and continues.
- A session holds a **forest of setup branches**. The user brings in multiple base setups (each its own root), experiments across branches, checks out any node, and takes "inspiration" (copy another branch's knobs into a new iteration).
- **Testing = min ~3 clean laps** (outlap + normal laps + optional inlap). Outlap/inlap weight ~0. On very long tracks (Nordschleife, Le Mans) 3 is too many — the per-run stint target adapts to track length.
- The engineer must **account for driver blunders / inconsistency**: a great setup with an inconsistent driver yields useless suggestions. When laps are scattered, the engineer **flags low confidence (never hard-blocks)** and offers to either suggest anyway or coach the driver on where they struggled.
- **Two intakes, one blended workspace.** Not everyone runs deliberate stints. The session accepts data two ways, both feeding the same engine and engineer: **(A) Run live test** — a deliberate stint on a checked-out branch (hardcore); **(B) Add laps from history** — attach existing laps from normal racing, matched by car+track+game (casual). Surfaced as two buttons in the same workspace, no mode toggle. The clean-aggregate + confidence score (Phase 1) is what makes intake B safe: passive laps are noisy, and the confidence score honestly reflects it rather than pretending.

**Outcome:** the engineer reasons over an aggregate of clean laps with a consistency score *grounded in racing-line + driver-input deviation* (not just lap-time spread), honestly flags when the data is too noisy to trust, distinguishes a setup problem from a driving problem, supports multiple base setups per session, works across ACC/AC-Evo (file setups) and F1 (telemetry setups), and shows a track-aware lap target.

Existing infrastructure to reuse (do NOT rebuild): the branch forest (`parentTestId`, `VersionGraph.buildForest` — already multi-root), `apply_changes`/`branch_from_version` tools, `consult_lap_analyst` (driver coaching), recap consistency math (`stddevPopulation`/`consistencyRating` in `server/recap.ts`), `telemetryToSymptoms`, `telemetryToTrackConditions`, `applyIntents`, `writeSetupFile`, `nextFreeLabel`. For the lap-consistency diff: the distance-grid resampler `compareLaps`/`interpolateChannel` (`server/comparison.ts`), arc-length primitives `normalizedArcLengths`/`interpolateAtFrac` (`server/track-calibration.ts:330-360`), corner ranges from `detectCorners` (`server/corner-detection.ts` — `distanceStart/End/apex`), and the roll-up pattern in `computeCornerDeltas` (`comparison.ts:176-202`). For F1: setup is already fully parsed (`F1CarSetup` on every packet via `server/parsers/f1-state.ts:537-566`, exposed at `shared/types.ts:169-193`).

**Constraints:** no dynamic imports (CLAUDE.md rule — static only). Tuning games: ACC, AC-Evo (file-based setups) **and F1 2025 (telemetry-based setups)** — a setup source/sink adapter abstracts the difference. Verify through the real app routes, not bespoke probes.

---

## Design decisions (approved)

1. **Consistency → flag + coach, never block.** Two independent signals: **overall confidence** = lap-time repeatability (HIGH/MED/LOW/VERY-LOW), **per-corner trust** = line/input consistency (decision 10). Ideal for a reliable suggestion is **~3 consistent laps** — this is a *soft* bar, never a hard gate. On low confidence the engineer quotes the spread and offers *suggest-anyway* or *coach-me* (`consult_lap_analyst`). **Immediate-fix bypass:** if the driver says the car is obviously wrong and needs changing now, the engineer suggests on whatever data exists, clearly caveating the low confidence — it never refuses.
2. **Trimmed clean-lap aggregate replaces single-fastest-lap.** Drop outlap/inlap (already `isValid=false`) + blunder outliers; aggregate remaining clean laps' symptoms; attach consistency. Fallback to single fastest lap when <2 clean laps (very-low confidence).
3. **Multi-root forest.** Import extra setups as new roots (`parentTestId=null`); "inspiration" = copy a branch's knobs into a new node.
4. **Track-length-aware soft lap target.** Advisory only, drives the live "current stint" copy/progress. Never blocks.
5. **Two intakes, blended.** `[ Run live test ]` (Mode A, deliberate stint) and `[ Add laps from history ]` (Mode B, import existing laps by car+track) both feed the same session. On import the user **assigns the laps to a target** (a specific branch, or session baseline) and sees a warning: *"Only import laps driven on this branch's setup, unchanged — otherwise the suggestions degrade."* No fuzzy setup auto-matching is even possible: ACC/AC-Evo telemetry doesn't output the car's setup (the per-lap `carSetup` snapshot is app-side, not game truth; only F1 exposes real setup), so there's no ground-truth fingerprint to match on. The user attests, the warning protects them.
6. **Manual lap exclusion + AI-judged sufficiency.** The user can mark any lap excluded from tuning consideration (dropped from the aggregate, beyond the auto-outlier rule). The AI decides whether there are enough valid clean laps for an accurate suggestion, and proactively **names specific laps it thinks should be excluded** (e.g. "lap 3 at +2.1s looks like an off — exclude it?"). Exclusion is a user action; the AI can also apply it (with the user in the loop) via a tool.
7. **Delete = soft (trash), subtree cascade, reversible.** Deleting a node trashes it *and its whole subtree* (children included), restorable from a trash view. Manual (UI) + an AI `delete_version` tool. Setup `.json` files stay on disk.
8. **Undo via an append-only action log.** Every mutating op (apply/branch/add-base/import/set-head/delete/rename/exclude) records its inverse in `tuning_actions`. Undo applies the inverse; both **user and AI** can undo. The log stores only small refs (no blobs), so full-session depth is cheap — no hard cap needed; the UI simply lists the history newest-first. The immutable node + versioned-setup snapshot design already gives per-step snapshots for free, so no separate blob snapshots.
9. **F1 support via a setup source/sink adapter.** F1's setup is telemetry-only (already parsed as `F1CarSetup`), with no writable file — you can't push a setup into F1. Abstract the setup read/write behind a per-game adapter: **ACC/AC-Evo = file** (`resolveGuardedSetupFile` read, `writeSetupFile` write); **F1 = snapshot** (base setup captured from telemetry into `tuning_tests.setup_snapshot`; "apply" produces a *target* `F1CarSetup` snapshot + advisory diff the user dials in-game). Build a deterministic `RULES['f1-2025']` table on the F1 value model (wings/PSI/kg, not ACC clicks) so `applyIntents` works for F1. F1 import needs **no setup-consistency warning** — F1 laps carry their real setup, so the import auto-verifies the setup matches the branch.
10. **Lap-consistency delta (line + inputs) grounds trustability.** Consistency is measured not just from lap-time spread but from **how much the driven line *and driver inputs* vary between clean laps, per corner** — lateral line spread, brake application (point + trace), and throttle application (point + trace). Consistent line and inputs but a slow/twitchy corner ⇒ setup problem; scattered line or inputs ⇒ driver problem. One pure `computeLapConsistencyDelta(cleanLaps, corners)` feeds the `ConsistencyReport` (per-corner spread across line/brake/throttle) *and* backs a dedicated agent tool `compare_lap_consistency`. This is the primary signal for separating a setup issue from a driving issue.
11. **Deterministic turn workflow — the model can't forget a read.** The analysis the engineer *always* needs (clean-lap aggregate, consistency, lap-consistency deviation, track conditions, current setup, version history) runs as **fixed Mastra workflow steps**, not model-chosen tool calls. The composed result is injected into the turn; the agent's remaining tools are the *actions* (apply/branch/add-base/set-lap-excluded/delete/undo) plus genuinely optional deep consults (`consult_lap_analyst` coaching, `compare_lap_consistency` depth). This removes per-tool "remember to call X" guidance from the system prompt (shrinking it to decision rules over already-present context) and makes the read pipeline deterministic and testable.

**One migration (v30).** New table `tuning_actions` (append-only action log); new columns `laps.tuning_excluded` (nullable int, user exclude flag) and `tuning_tests.setup_snapshot` (text JSON — F1's captured/target `F1CarSetup`; null for file-based ACC nodes). Delete reuses `tuning_tests.status` with a new `'deleted'` value (text column — no DDL change). A root is still `parentTestId IS NULL`; labels via `nextFreeLabel`; no `test_runs` table (a "run" = laps sharing `tuningTestId`); `baseSetupPath` stays the primary-base pointer for file games; imported laps reuse `tuningSessionId`/`tuningTestId` stamping.

---

## Phase 0 — Migration v30 + schema sync

Append one entry to the bottom of `server/db/migrations.ts` (raw SQL), mirror in `server/db/schema.ts`, no FK ALTERs (SQLite limitation — soft refs):
- `laps.tuning_excluded INTEGER` (nullable; 1 = user-excluded from tuning). Add to `laps` table def in schema.ts + the lap projections that feed the aggregate.
- `tuning_tests.setup_snapshot TEXT` (nullable JSON) — F1's captured base / target `F1CarSetup`; null for file-based ACC/AC-Evo nodes (which keep using `setupPath`). Add to `CreateTuningTestData` + insert in `tuning-test-queries.ts`.
- New table `tuning_actions`: `id` PK, `tuningSessionId` int (soft ref), `kind` text, `inversePayload` text (JSON), `undone` int default 0, `createdAt`. Index `idx_tuning_actions_session`. Add a Drizzle table def + `server/db/tuning-action-queries.ts` (`recordAction`, `listActions`, `markUndone`).
- `tuning_tests.status` gains a `'deleted'` value — text column, no DDL change; just widen the TS union in schema.ts.

## Phase 1 — Clean-lap aggregate + consistency (server core, the keystone)

New module **`server/ai/clean-lap-aggregate.ts`** (static imports; keeps `setup-engineer-context.ts` lean).

First, promote `stddevPopulation` + `consistencyRating` out of `server/recap.ts` into a shared **`server/lap-stats.ts`**, imported by both recap and this module (so the consistency math can't drift).

**Types** (re-exported from `setup-engineer-context.ts` for a single import site):
```ts
type Confidence = "high" | "medium" | "low" | "very-low";
interface ConsistencyReport {
  confidence: Confidence; cleanLapCount: number;
  bestLapSec: number | null; spreadSec: number | null;
  stdDevSec: number | null; spreadPct: number | null; droppedOutliers: number;
  // Lap-consistency grounding (Phase 11): per-corner variance across the clean laps over line + inputs.
  // High spread at a corner => inconsistent driving there => that corner's symptom read is low-trust (driver, not setup).
  cornerConsistency: {
    corner: string;
    lateralSpreadM: number;   // racing-line spread
    brakeVar: number;         // brake application variance (point + pressure trace)
    throttleVar: number;      // throttle application variance
    lowTrust: boolean;        // any channel over its threshold
  }[] | null;
}
interface LapBreakdownRow {
  lapId: number; lapTimeSec: number; valid: boolean;
  reason: "clean" | "invalid" | "user-excluded" | "auto-outlier";
  imported: boolean;
}
interface CleanLapAggregate {
  ok: boolean; lapIds: number[];
  symptoms: TuneSymptoms | null; trackConditions: TrackConditions | null;
  consistency: ConsistencyReport; fallbackSingleLap: boolean;
  sourceScope: "branch" | "session-baseline"; // "session-baseline" = fell back to session pool (may mix setups; confidence capped medium — issue C)
  lapBreakdown: LapBreakdownRow[]; // every candidate lap + why it was kept/dropped — lets the AI name specific laps to exclude
}
```

**Functions:**
1. `selectCleanLaps(laps)` -> `{ clean, dropped }`. Start from valid laps (`isValid && lapTime>0`) — outlap/inlap/pit already excluded by `isValid=false`. **Drop user-excluded laps** (`tuning_excluded=1`, reason `user-excluded`). Blunder rule: drop `lapTime > max(median + 1.5·IQR, best·1.02)` (reason `auto-outlier`). Emit a `LapBreakdownRow` per candidate.
2. `computeConsistency(cleanLaps)` -> `ConsistencyReport`. Reuse `server/lap-stats.ts`. `spreadPct = spread/best`. Overall band = **lap-time repeatability** (issue A: this is time-only; per-corner line/input trust lives in `cornerConsistency`, kept separate). Bands: `high` (>=3 clean, spreadPct<0.01), `medium` (>=2, <0.02), `low` (>=2, >=0.02), `very-low` (<2 clean). The >=3 bar is the *ideal* (~3 consistent laps), **soft — nothing here blocks**; it only sets how loudly the engineer caveats. **Not track-scaled** — long tracks reach HIGH by accumulating consistent laps across runs, and use the immediate-fix bypass (decision 1) when the driver needs a change now.
3. `aggregateSymptoms(perLap: TuneSymptoms[])` -> `TuneSymptoms`. `TuneSymptoms.aggregate` is structured, not flat: `balance` = majority vote; corner-name lists (understeer/oversteer/lockup/bottoming) = include a corner if present in >=ceil(n/2) laps; numeric leaves (tyrePressure/tyreTemp/damper/weightTransfer) = median per field (null if none report); keep the fastest clean lap's `corners[]` spine (prompt consumes only the `aggregate` block via `formatSymptoms`).
4. `loadCleanLapAggregate(sessionId, opts?: { testId? })`. Pool = head-test laps (Phase 2, `sourceScope:"branch"`) else session pool (`sourceScope:"session-baseline"`, confidence capped `medium` — issue C). `<2 clean` -> `fallbackSingleLap=true` via existing `loadRepresentativeLap`, confidence `very-low`, `cornerConsistency=null` (needs >=2 laps). Else `getLapById` each clean lap (guard `telemetry.length>=30`), per-lap `telemetryToSymptoms`, `aggregateSymptoms`; conditions from the fastest clean lap; resolve corners once (persisted `getCorners(trackOrdinal, gameId)`, else `detectCorners` on the fastest clean lap — same source the Lap Analyst uses at `consult-lap-analyst.ts:39-40`); **`computeLapConsistencyDelta(cleanLaps, corners)` (Phase 11)** to fill `cornerConsistency` (line + brake + throttle variance) and down-trust corners with scattered driving. Cap at top ~8 clean laps to bound cost.

Add a thin `computeSessionAggregate(sessionId, testId?)` wrapper in `setup-engineer-context.ts`. **Leave `loadRepresentativeLap`/`computeSessionSymptoms`/`computeSessionTrackConditions` intact** — the Lap Analyst (`server/ai/consult-lap-analyst.ts:34`) and back-compat depend on them.

## Phase 2 — Lap->test query for the current run

`server/db/queries.ts`: add `getLapMetaForTuningTest(testId)` — same select as `getLapsForTuningSession` but `where(eq(laps.tuningTestId, testId))`, **and add `tuningTestId` to the projection** (currently absent from both selects). Aggregate prefers head-test-stamped laps; when the head test has <2 stamped laps (pre-v29 / no head set), it falls back to the session-wide clean pool — **but that pool may contain baseline/imported laps driven on a different setup (issue C).** So the fallback path is marked in the aggregate as `sourceScope: "session-baseline"` and its confidence is **capped at `medium`**, and the CONFIDENCE block tells the model the reads are broad-baseline (possibly mixed setup), not a clean branch stint. Only head-test-stamped laps count as a true branch aggregate.

## Phase 3 — Deterministic turn workflow + slimmed prompt

**Make the read/analysis pipeline deterministic** (decision 11). Extend the existing `mastra/workflows/setup-engineer-turn.ts` so the turn is a workflow whose fixed steps always run before the agent — the model cannot skip a read:

- `gatherPrereqs` (:39-87) becomes the authoritative composer. It calls `loadCleanLapAggregate(sessionId)` **once** (which internally runs the aggregate + consistency + lap-consistency deviation) and emits the full context block:
  - `CONFIDENCE` (confidence, cleanLapCount, spreadSec/spreadPct, droppedOutliers, fallbackSingleLap, sourceScope — flags branch stint vs possibly-mixed session baseline)
  - `LAP BREAKDOWN` (every candidate lap: id, time, kept/dropped + reason, imported) so the model can name specific laps
  - `CONSISTENCY BY CORNER` (per-corner line + brake + throttle variance, `lowTrust` flags) — the setup-vs-driver signal
  - `SYMPTOMS (aggregate over N clean laps)` via `formatSymptoms(agg.symptoms)`
  - `TRACK CONDITIONS` from `agg.trackConditions` (drop the separate `computeSessionTrackConditions` call)
  - `CURRENT SETUP` + `VERSION HISTORY` (kept)
- Because these are guaranteed present, the agent's tools reduce to **actions + optional depth**: `apply_changes`/`branch_from_version`/add-base/`set_lap_excluded`/delete/undo (writes), and `consult_lap_analyst` (coaching) + `compare_lap_consistency` (deep line+input view) as the only *optional* calls. No read tool the model must "remember."
- `mastra/agents/setup-engineer.ts` `SETUP_ENGINEER_INSTRUCTIONS` (:42-57) **shrinks** — remove per-tool "gather X first" choreography; keep only decision rules over the now-guaranteed context:
  - **Confidence:** on `low`/`very-low`, flag it, quote the spread, **never hard-block**; offer *suggest-anyway* (caveated) or *coach-me* (call `consult_lap_analyst`). If the driver says the car is obviously wrong and needs a change now, suggest anyway with a caveat (immediate-fix bypass, decision 1).
  - **Sufficiency:** judge against the soft ideal of ~3 consistent laps; if short, say e.g. "2 of ideally 3 consistent laps — one more clean run raises confidence, or tell me to proceed." Never a wall.
  - **Exclusions:** when the LAP BREAKDOWN shows a lap that looks like a blunder (off, spin, big outlier), name it and offer to exclude it — via the new `set_lap_excluded` tool (below), with the user in the loop.
  - **Setup vs driver:** use `cornerConsistency` — for a corner with high line/brake/throttle variance (`lowTrust`), treat its symptom read as likely *driving* inconsistency, not the car; say so rather than tuning for it. When line and inputs are tight but the corner is still slow/twitchy, it's a genuine setup signal.
- **New tool** `set_lap_excluded(lapId, excluded)` in `mastra/tools/setup-engineer.ts`: flips `laps.tuning_excluded`, records a `tuning_actions` entry (Phase 9). Advisory-first — the model proposes, applies on user agreement. Register alongside the existing action tools (:71-76).
- **New tool** `compare_lap_consistency(opts?)` in `mastra/tools/setup-engineer.ts`: runs `computeLapConsistencyDelta` (Phase 11) over the session's clean laps on demand and returns the major per-corner deviations across line + brake + throttle (the deeper, on-request view beyond the summary already in the CONSISTENCY block). Read-only.

## Phase 4 — Multi-base forest (add base / inspiration)

- **Add-a-base endpoint** — `POST /api/tuning-sessions/:id/bases` in `server/routes/tune-routes.ts` (near :912), body `{ setupPath, label? }`: guard via `resolveGuardedSetupFile`, `nextVersion(id)`, `createTuningTest({ label: nextFreeLabel(label ?? "base"), setupPath, parentTestId: null, engine: null })`, optional `setSessionHead`, canned chat ack like `/head` (:958). Returns the created test.
- **Inspiration** — generalize the existing `branch_from_version` tool (`mastra/tools/setup-engineer.ts:351`): add optional `asNewRoot?: boolean` -> when true, `parentTestId=null` so copied knobs seed a new root. Reuses its byte-copy + label + setHead logic. Optionally expose a non-chat `POST /:id/inspire`.
- **UI** — `VersionGraph` needs no forest change (already multi-root). Add an "Add base" affordance near `VersionGraph` in `TuningSessionWorkspace.tsx:191` (reuse the setup-picker from `NewTuningSessionModal`), and a per-node "Use as inspiration" action. Add `useAddBase` in `client/src/hooks/queries.ts` (sibling to `useSetHead`) via `client.api` RPC, invalidating session/tests/chat.

## Phase 5 — Track-length-aware stint nudge (advisory, decoupled from confidence)

**Decoupled from the confidence model (issue B):** this is *only* the per-run "how many laps is a full stint here" nudge in the live UI — it does **not** set the confidence bar (that stays the soft ~3-consistent-laps ideal, Phase 1). On a 25 km track the nudge is ~1 lap/run; confidence still accrues across runs.
- New pure helper **`shared/lap-target.ts`** (no fs): `suggestLapTarget(estLapSec, trackLengthM)` -> `targetLaps = clamp(round(TARGET_GREEN_MIN*60 / estLapSec), 1, 4)`. `estLapSec` precedence: best lap -> `trackLengthM / AVG_SPEED_MPS` (~45 m/s) -> default 3. Constants tunable (`TARGET_GREEN_MIN≈6`).
- `getTrackLengthMeters` (`shared/track-data.ts`) is fs-backed = server-only. Compute `lapTarget` server-side on session GET (`tune-routes.ts:1183`) and ship it on the session payload.
- `TuningSessionWorkspace.tsx:200-202`: replace the hardcoded `/ 3` and "run 3+ clean laps" copy with `session.lapTarget` (fallback 3); progress = `min(lapsDone, target)/target`. Advisory — never blocks Review/Close. Copy frames it as a per-run target, e.g. "N clean laps this run".

## Phase 6 — Add laps from history (Mode B / collect)

Lets casual users attach laps driven during normal racing. Reuses the existing `tuningSessionId`/`tuningTestId` stamping — no schema change.

- **Candidate query** — `GET /api/tuning-sessions/:id/importable-laps` in `tune-routes.ts`: laps matching the session's car+track+game (via `carOrdinal`/`trackOrdinal`, and name fallback for name-seeded sessions) that aren't already stamped to this session. Return lap meta (time, valid, sessionId, createdAt) for the picker.
- **Attach endpoint** — `POST /api/tuning-sessions/:id/import-laps`, body `{ lapIds: number[], tuningTestId?: number }`: stamp `tuningSessionId` on each (and `tuningTestId` when a branch target is chosen). When no `tuningTestId`, laps stay session-level baseline.
- **Aggregate wiring** — Phase 1 needs no change: branch-stamped imported laps flow into that branch's aggregate (`sourceScope:"branch"`, user-attested to the setup); session-only imported laps form the baseline pool, consumed only via the Phase 2 fallback as `sourceScope:"session-baseline"` (confidence capped `medium`, flagged possibly-mixed-setup — issue C).
- **UI** — in `TuningSessionWorkspace.tsx`, the idle left panel shows two buttons: **Run live test** (existing -> `testPhase="live"`) and **Add laps from history** (opens an import modal). Modal: lists importable laps (multiselect, best-lap/validity shown), a target selector (branch dropdown or "Baseline only"), and a **setup-consistency warning banner for file games (ACC/AC-Evo) only**. **For F1 the warning is suppressed** — F1 laps carry their real `F1CarSetup`, so on import the server compares each lap's captured setup to the branch's `setup_snapshot` and either confirms the match or shows a precise per-field mismatch (no vague "make sure" warning needed). Add `useImportableLaps` + `useImportLaps` in `client/src/hooks/queries.ts`; invalidate session/tests/laps/chat on success.
- **Engineer awareness** — the CONFIDENCE section (Phase 3) notes when the aggregate draws on imported/baseline laps so the model can caveat accordingly.

## Phase 7 — Manual lap exclusion (UI)

The server + AI side lands in Phases 0/1/3; this is the user-facing toggle.
- **Endpoint** — `POST /api/laps/:id/tuning-excluded` (or `PATCH`), body `{ excluded: boolean }`: set `laps.tuning_excluded`, record a `tuning_actions` entry. (The AI reaches the same setter via `set_lap_excluded`.)
- **UI** — add an "exclude from tuning" toggle per lap in `tune-version-shared.tsx` `LapBreakdown` and in `TestReviewDashboard` per-lap tabs. Excluded laps render struck-through/dimmed with an "excluded" chip. `useSetLapExcluded` in `client/src/hooks/queries.ts`, invalidating laps/session/chat.

## Phase 8 — Delete / trash nodes (subtree, reversible)

- **Endpoint** — `POST /api/tuning-sessions/:id/tests/:testId/delete` in `tune-routes.ts`: collect the node + all descendants (walk `parentTestId`), set `status='deleted'` on each, record one `tuning_actions` entry carrying the affected ids (for undo/restore). If the head test is in the trashed subtree, move head to the nearest surviving ancestor (or session base) — capture the prior head in the inverse payload. A `restore` path flips the subtree back to `active`.
- **AI tool** — `delete_version(testId)` in `mastra/tools/setup-engineer.ts`, same subtree soft-delete, records the action.
- **Reads** — `listTuningTests` / the `/tests` endpoint filter out `status='deleted'` by default; add `?includeDeleted=1` for a trash view. `VersionGraph.buildForest` already ignores nodes it isn't given, so no graph change.
- **UI** — per-node "Delete branch" (with a "this trashes the whole subtree" confirm) in `VersionGraph`; a "Trash" disclosure listing deleted nodes with **Restore**. `useDeleteVersion` + `useRestoreVersion` hooks.

## Phase 9 — Action history + undo (user + AI)

- **Recording** — each mutating op writes a `tuning_actions` row via `recordAction(sessionId, kind, inversePayload)`. `kind` in { apply-changes, branch, add-base, inspire, import-laps, set-head, delete, restore, rename-note, set-lap-excluded }. `inversePayload` stores exactly what's needed to reverse it (created testId to soft-delete; prior head id; prior lap stamps / exclude flag; prior note text). Wire into the existing writers: `apply_changes`/`branch_from_version` (`mastra/tools/setup-engineer.ts`), `/head`, `/bases`, `/import-laps`, delete, `set_lap_excluded`, PATCH rename.
- **Undo endpoint** — `POST /api/tuning-sessions/:id/undo`: take the newest not-yet-undone action, apply its inverse (delete->restore uses the same soft-delete flip; apply/branch/add-base->soft-delete the created node + restore head; import->unstamp; set-head->restore prior head; exclude->restore prior flag; rename->restore text), mark it `undone`. Idempotent, newest-first.
  - **Guard (issue F):** undoing an apply/branch soft-deletes the node it created; if the user has since driven laps stamped to that node, those laps get orphaned onto a trashed node. So undo of a node that already has stamped laps (or children) **warns** ("this version has N laps / child branches — undoing trashes them too; they're restorable") and, like delete, soft-deletes the whole subtree so nothing is silently stranded. Laps survive (soft-deleted node still exists); restore brings them back. Since driving laps isn't a logged action, the newest-action target is unchanged by lapping.
- **AI tool** — `undo_last_action()` in `mastra/tools/setup-engineer.ts` so the user can say "undo that." Same endpoint logic. (Both user and AI can undo, per decision 8.)
- **UI** — a History panel (session-scoped) listing actions newest-first with a top-level **Undo** button; `useTuningHistory` + `useUndo` hooks, invalidating session/tests/laps/chat. Log is tiny (refs only) so full-session depth is kept.

## Phase 10 — F1 2025 tuning support (setup source/sink adapter + F1 rules)

F1 setup is already parsed (`F1CarSetup` on every packet, `server/parsers/f1-state.ts:537-566`); the work is entirely on the tuning side, which is currently ACC-file-specific (8 blockers).

- **Setup source/sink adapter** — introduce a small per-game abstraction (e.g. `server/ai/setup-io.ts`) with two implementations:
  - *File* (ACC/AC-Evo): `read` = `resolveGuardedSetupFile`, `write` = `writeSetupFile` (existing behavior, unchanged).
  - *Snapshot* (F1): `read` = the node's `setup_snapshot` JSON, or capture from the representative lap's telemetry (`firstPacketF1Setup`, `server/routes/lap-routes.ts:79-86`) when seeding a base; `write` = store the target `F1CarSetup` on the new `tuning_tests.setup_snapshot` (no file).
  - **Base-capture timing (issue E):** an F1 session has no setup at creation (no telemetry yet). So the base node's `setup_snapshot` is left null and **backfilled from the first lap that carries `f1?.setup`** (stamp on lap insert / first-aggregate), or set immediately via a live "capture current setup" action when telemetry is flowing. `loadActiveTuningContext` treats a null F1 snapshot as "base not captured yet — drive a lap or capture from live."
  - Route `loadActiveTuningContext` (`setup-engineer-context.ts:198-218`) through the adapter and **lift the `acc|ac-evo` hard-reject** to allow `f1-2025`.
- **F1 rules table** — add `RULES['f1-2025']` in `server/ai/tune-rules.ts` mapping intents to `F1CarSetup` fields (frontWing/rearWing, on/offThrottleDiff, camber, toe, ARB, ride height, brakeBias/pressure, tyre pressures) with each field's real range/step and clamps. **Source the valid ranges from the existing F1 setup data (`server/ai/f1-setup-catalog.ts` + bundled `shared/tunes/f1-25/f1laps/*/setups.json`) — do NOT invent ranges (issue D, correctness-critical):** wrong bounds produce invalid setups. `applyIntents(gameId=…)` then returns real applied/skipped for F1 on the F1 value model. This is the largest single piece of F1 work — budget for it.
- **Session creation gates** — relax the `z.enum(["acc","ac-evo"])` schemas in `tune-routes.ts` (autotune/base/import) to include `f1-2025` where a file isn't required; F1 base selection is "capture current setup from telemetry" rather than pick-a-file. `getSetupsBaseDir` stays ACC/AC-Evo only (F1 never touches it).
- **Apply output** — for F1, the `apply_changes`/version node stores the target snapshot and the chat posts an **advisory diff** ("dial these in-game: front wing 6->8…") via `buildAppliedChangesMarkdown` (already game-agnostic on the applied list). No "load this file" line for F1.
- **UI** — F1 tuning routes/workspace mirror ACC (the workspace is game-agnostic via `gameId`); the "Add base" affordance for F1 = "capture current car setup" instead of a file picker. Everything else (VersionGraph, chat, aggregate, lap-consistency, undo) is already game-agnostic.

## Phase 11 — Lap-consistency delta: line + inputs (shared pure fn + agent tool)

Grounds trustability in *where the driven line and driver inputs vary*, per corner. Reuses the distance-grid aligner and arc-length primitives; no new geometry libraries.

- **Shared path extractor** — factor the duplicated frames->`{x,z}` logic (currently unexported in `TrackMap.tsx:49-75`, `AnalyseTrackMap.tsx:81`, `CompareTrackMap.tsx:96`, and inlined server-side) into one exported helper (e.g. `shared/lib/lap-path.ts`) using `PositionX`/`PositionZ` with the existing velocity-integration fallback. Client renderers + this feature both consume it.
- **Consistency function** — new `server/lap-consistency.ts`: `computeLapConsistencyDelta(laps: TelemetryPacket[][], corners): { perCorner: {corner, lateralSpreadM, brakeVar, throttleVar, lowTrust}[]; overall }`. Resample each lap by normalized track-distance fraction using `normalizedArcLengths` + `interpolateAtFrac` (`server/track-calibration.ts:330-360`), producing per-fraction-bin samples of **position (X/Z), `Brake`, and `Throttle`** (reuse `interpolateChannel` from `comparison.ts:106-139` for the input channels). At each bin compute cross-lap spread: lateral distance from the bin centroid for line; population variance for brake and throttle. Roll up to corners with the `computeCornerDeltas` index-mapping pattern (`comparison.ts:176-202`) over `detectCorners` `distanceStart/End`. Mark a corner `lowTrust` when any channel exceeds its threshold (line ~1.5 m; brake/throttle variance tunable). Pure + deterministic -> unit-testable.
  - Note: the existing `compareLaps` aligner proxies `posX/Z` from *velocity* (`comparison.ts:94-95`); this feature must use true `PositionX/Z`, so resample position directly via the arc-length primitives (preferred — avoids touching compare-endpoint behavior). `Brake`/`Throttle` are already real channels.
- **Consumers** — (1) `loadCleanLapAggregate` (Phase 1) calls it to fill `ConsistencyReport.cornerConsistency`; (2) the `compare_lap_consistency` agent tool (Phase 3) returns the major deviations on demand. Optional later: a client overlay showing the spread band on the track map (not required for the AI value).

---

## Suggested staging

Ships incrementally:
- **Core (independently shippable):** Phase 0 migration -> Phases 1–3 (multi-lap aggregate + consistency + honest flagging + sufficiency judgment). This is the main value.
- **Trustability booster:** Phase 11 (lap-consistency delta — line + brake + throttle) — slots into the core's `ConsistencyReport`; land right after core since it's the strongest setup-vs-driver signal.
- **Additive, any order after core:** Phase 4 (multi-base), Phase 5 (lap target), Phase 6 (import from history — highest-leverage casual feature), Phase 7 (manual lap exclusion).
- **New game:** Phase 10 (F1 support) — independent of the safety net; depends only on core + the setup-io adapter. Bigger surface (F1 rules table), so a tranche of its own.
- **Safety net (best landed together):** Phase 8 (delete/trash) + Phase 9 (action history + undo) — undo is what makes delete and every AI mutation safe to offer, so ship them as a pair.

**Recommendation (issue G):** this spec is effectively ~5 shippable projects. **Build and validate the core tranche first (Phase 0->1->2->3->11) and confirm suggestion quality actually improves on real laps** before committing to F1 (Phase 10, biggest surface), import (6), or the safety net (8+9). Each tranche could reasonably be its own PR/spec; treat the phase numbers as dependency order, not a single mega-merge.

**Cross-cutting cleanups to do with the relevant phase:** (1) when Phase 8 adds `status='deleted'`, audit *every* `listTuningTests`/`/tests` caller to exclude it (not just the graph) — stray callers would resurface trashed nodes. (2) Extract the setup-picker sub-component out of `NewTuningSessionModal` (`TuningSessionList.tsx`) so Phase 4 "Add base" and Phase 6 import reuse it without dragging in creation-only logic.

---

## Verification (real routes + bun tests)

- **Unit:** `test/clean-lap-aggregate.test.ts` — `selectCleanLaps` drops a `best·1.05` blunder, keeps a tight field; confidence bands (3-tight=high / 2-spread=low / 1=very-low); `aggregateSymptoms` majority/median over hand-built `TuneSymptoms`. `test/lap-target.test.ts` — clamp short-track->4, long->1, heuristic fallback. `test/lap-consistency.test.ts` — two identical synthetic laps -> ~0 spread; a lap offset 3 m through one corner -> that corner `lowTrust` on line; a lap braking 20 m earlier through one corner -> that corner `lowTrust` on brakeVar; others not. `test/tune-rules-f1.test.ts` — `applyIntents('f1-2025', …)` moves the right `F1CarSetup` field within range and clamps at the limit. Extend `test/tuning-lap-metrics.test.ts` if the stddev helper moves.
- **E2E over HTTP** (`bun run dev:server`, header `X-Game-Id: acc`): create session -> v1 base; `POST /:id/bases` -> `GET /tests` shows a 2nd root, workspace renders two roots; `branch_from_version asNewRoot` -> new root from another branch; `POST /:id/chat` on a low-consistency lap set -> response flags confidence, judges sufficiency, names a blunder lap to exclude, offers suggest/coach; `GET /:id` -> `lapTarget` present, live strip reads "N / <target>".
- **Exclusion:** `POST /api/laps/:id/tuning-excluded {excluded:true}` -> that lap leaves the aggregate (`lapBreakdown` reason `user-excluded`, cleanLapCount drops); the `set_lap_excluded` tool does the same and logs an action.
- **Delete + undo:** `POST /:id/tests/:testId/delete` on a node with children -> whole subtree `status='deleted'`, head moved off it, hidden from `/tests` (visible with `?includeDeleted=1`); `POST /:id/undo` -> subtree restored, head back. Repeat for apply-changes (undo soft-deletes the new node + restores head), import (undo unstamps), set-head (undo restores prior head). Confirm `undo_last_action` tool path matches the endpoint. Verify newest-first ordering and idempotency.
- **F1 (`X-Game-Id: f1-2025`):** create an F1 tuning session, capture base setup from a lap's telemetry -> `setup_snapshot` populated; `POST /:id/chat` -> engineer reads real F1 setup + symptoms + lap-consistency, `apply_changes` stores a target snapshot and posts an advisory diff (no "load file" line); import F1 laps -> no warning, setup match confirmed/diffed.
- **Lap consistency:** `compare_lap_consistency` on a session whose laps differ in line or braking through one corner -> that corner reported as a major deviation; confirm `ConsistencyReport.cornerConsistency` marks it `lowTrust` and the agent attributes it to driving, not setup.
- **Manual:** inspect the injected `gatheredContext` (CopyChatJson debug button / server log) to confirm SYMPTOMS reflects multiple laps and the LAP BREAKDOWN lists per-lap keep/drop reasons.
- **Migration:** run server on a DB copy, confirm v30 (`tuning_actions` table + `laps.tuning_excluded` + `tuning_tests.setup_snapshot` columns) via `.schema`, re-run for idempotency.
- **Build gate:** `cd client && bun run build` (tsc + vite) + `bun run test`.

## Tunable defaults (chosen; easy to revisit)

Outlier `> max(median+1.5·IQR, best·1.02)`; confidence bands 0.01/0.02 spreadPct at >=3/>=2 clean; `TARGET_GREEN_MIN≈6`, `AVG_SPEED_MPS≈45`, lap-target clamp 1..4; aggregate cap ~8 laps; consistency `lowTrust` thresholds — line lateral-spread ≈1.5 m, brake/throttle variance tuned against real clean-lap data; resample ≈200 fraction bins.
