# Setup Engineer: tool-based agent + grounded generation + version branching

Reshape the tuning-session setup chat from a monolithic-prompt + separate
`generate-from-chat` endpoint into a **tool-using Mastra agent**. Tools make the
applyable action space the *only* action space, which fixes the grounding bug
(the model recommending knobs the engine can't turn, or adding undiscussed
changes). Then add version **branching** so the driver can back-track to a faster
setup and try a different direction.

Builds on: `server/ai/tune-rules.ts` (`applyIntents`, `knownComponents`),
`server/ai/tune-writer.ts` (`writeSetupFile`), `server/db/tuning-test-queries.ts`
(`tuning_tests` with `parentTestId`), the chat infra (`server/ai/chat-stream.ts`
`startChatStream`, Mastra memory), and `docs/setup-iq-parity-plan.md` §4d
(deterministic rules own the numbers — LLM only picks direction/magnitude).

---

## 1. Problem recap
Observed: driver discussed **front ARB + front ride height (aero)**; the generated
v3 changed **ARB + tyre pressure FL**, no aero. Root causes:
- **Ride height isn't in the rules table** → the discussed change maps to no
  component → silently dropped.
- The intent step **added tyre pressure** that was never discussed.
- The chat has no idea what's applyable, so it recommends un-turnable knobs.

Tools fix the last two by construction; the first needs the rules table expanded.

---

## 2. Phase 1 — expand the deterministic rules table (grounding foundation)
`server/ai/tune-rules.ts`. Verified ACC setup JSON paths (from a real setup file):

| Knob (driver-facing) | ACC path | Notes |
|---|---|---|
| Front Ride Height | `advancedSetup.aeroBalance.rideHeight[0]` (+`[1]`) | front pair; raising = less rake |
| Rear Ride Height | `advancedSetup.aeroBalance.rideHeight[2]` (+`[3]`) | rear pair; raising = more rake |
| Front Bump (slow) | `advancedSetup.dampers.bumpSlow[0..1]` | axle-level |
| Rear Bump (slow) | `advancedSetup.dampers.bumpSlow[2..3]` | |
| Front Rebound (slow) | `advancedSetup.dampers.reboundSlow[0..1]` | |
| Rear Rebound (slow) | `advancedSetup.dampers.reboundSlow[2..3]` | |
| Diff Preload | `advancedSetup.drivetrain.preload` | scalar |
| (existing) ARB F/R, Brake Bias, Front/Rear Wing, Tyre Pressures | unchanged | |

**Rules-engine change**: `FieldDef` currently targets a single `path`. Symmetric
axle knobs (ride height, dampers) move a **pair** of array indices together. Extend
`FieldDef` to accept `paths: string[]` (apply the same clamped delta to each), and
have `applyIntents` iterate. Single-path knobs pass a one-element array. Record one
`AppliedChange` per driver-facing knob (not per index) so history reads cleanly.

Risks (§5): ACC `rideHeight` index→corner mapping and click-step semantics differ
per car class — verify against a couple of real GT3 setups before shipping wide;
fast-clamp min/max per car may need scaling. Ship incrementally; unknown paths
`skip` safely. AC-Evo paths TBD (its setup snapshot shape differs) — add where known.

Tests: `applyIntents` over the new knobs (ride height moves both front indices,
clamps hold, one AppliedChange emitted).

---

## 3. Phase 2 — tool-using setup-engineer agent
Replace the monolithic chat prompt + `generate-from-chat` endpoint with an agent
that operates via tools (Mastra `createTool`, zod input schemas). The chat-stream
already emits `tool` events, so the UI shows "proposing… / applying…".

**Read tools**
- `get_current_setup` → active version's values + **the tunable knobs with current
  value + range** (from `knownComponents(gameId)`). The agent only sees what it can move.
- `get_symptoms` → deterministic symptom report if a lap exists, else "no lap yet".
- `get_version_history` → versions, applied changes, best lap per version, parents.

**Action tools**
- `propose_change({ component, direction, magnitude, reason })` — `component` is a
  **zod enum of the game's applyable knobs** (from `knownComponents`); magnitude
  small/medium/large. Runs the deterministic math on a scratch copy and returns the
  resulting clamped value, so the agent states the *real* effect. Accumulates a
  pending set (in the tool's run context / a per-thread scratch).
- `apply_changes({ baseVersion? })` — commit: `applyIntents` → `writeSetupFile`
  (versioned) → `createTuningTest` (parent = baseVersion ?? latest). Returns new
  version + diff; posts the applied summary as the assistant message (already built).
- `discard_changes`.

**Why grounded**: the model literally cannot propose a knob outside the enum; a
discussed-but-unavailable knob (e.g. ride height before Phase 1) yields an explicit
"not exposed" instead of a silent substitution. Numbers stay deterministic.

Wiring: a dedicated `setupEngineerAgent` (Mastra) with these tools, streamed via
the existing `startChatStream`. The system prompt shrinks — the tools carry the
contract. Retire `requestTuneIntentsFromChat` / the `generate-from-chat` prompt;
`apply_changes` is now the generate. The client "Generate setup from this chat"
button can either stay (calls a "please apply what we discussed" turn) or be
replaced by the agent calling `apply_changes` when the driver confirms.

---

## 4. Phase 3 — branching + backtrack
Data exists: `tuning_tests.parentTestId` + best-lap-per-version.
- `branch_from_version({ version })` tool (and a UI affordance on the version row):
  sets the base the next `apply_changes` builds on — its `setupPath` becomes the
  source, `parentTestId` the branch point. So the driver can go back to the faster
  v2 and try a different change instead of stacking on a slower v4.
- **Regression detection**: when the latest version's best lap is slower than an
  earlier version's, surface "v4 is +0.4s vs v2 — branch a new change from v2?"
  (server compares best-lap-per-version; client prompts). Optional auto-suggest.
- Version table renders the parent tree (indent children under parents).

---

## 5. Later — outcome-feedback loop (the "self-improvement")
Not model training. After each version, compare best lap vs parent and feed
"ARB−1 → +0.3s slower here" into `get_version_history` / the agent context, so
within a session the agent grounds its next suggestion in real outcomes. Mastra
scorers (existing `mastra/evals/`) can gate prompt/tool changes. Fine-tuning a
small model is a *later* cost optimisation once a large chat→intent→lap-outcome
log exists — never let it pick raw numbers (rules keep that).

---

## 6. Conventions / sequencing
- Server-side compute; deterministic rules own numbers (§4d); setup writes via
  `writeSetupFile`'s guarded dir; no dynamic imports; gameId via `GameIdSchema`.
- Build order: **Phase 1 (rules table)** first — it's the concrete grounding fix
  and independently testable — then Phase 2 (tools/agent), then Phase 3 (branching).
- No new DB table needed (branching reuses `parentTestId`).
