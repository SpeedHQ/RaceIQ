# Tuning-Session Workspace: Implementation Plan

The workspace that opens **inside** a tuning session (after Create session /
Resume — `?tuningSession=<id>`). Live-first: the driver runs stints, the panel
summarises as laps arrive, then Save triggers the deterministic tune
recommendation and spins up the next setup version. Builds on the parity plan
(`setup-iq-parity-plan.md`, Phases 1/3/4/5) and the sessions front door (§6a).

Decisions locked with the user: **plan first**, **live-first** (review is a
secondary mode).

---

## 1. Target layout

```
┌───────────────────────────────────────────────────────────────┐
│  ← Tuning sessions      <car> · <track>            [live/review]│
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │  ← stat cards
│  │ Laps │ │ Best │ │ Avg  │ │Drive │ │Fuel/ │ │ Tyre │        │
│  │      │ │ lap  │ │ lap  │ │ time │ │ lap  │ │ deg  │        │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘        │
│ ┌───────────────────────────────────┐ ┌────────────────────┐  │
│ │ TUNE TESTS (setup versions)       │ │ CURRENT STINT (live)│  │
│ │ v1 base   3 laps  1:29.6 best  ▸  │ │ 2 / 3 laps min      │  │
│ │  ├ L1 1:31.2  fuel 2.7  tyre …    │ │ best 1:30.4         │  │
│ │  ├ L2 1:29.6★ fuel 2.7  tyre …    │ │ avg  1:31.0         │  │
│ │  └ L3 1:30.1  fuel 2.8  tyre … 🌀 │ │ fuel/lap 2.7        │  │
│ │ v2 ARB−1  2 laps  1:29.1 best  ▸  │ │ tyre deg …          │  │
│ │ …                                 │ │ ------------------- │  │
│ │                                   │ │ Comment (→ AI):     │  │
│ │                                   │ │ [ loose on entry  ] │  │
│ │                                   │ │ [ Save & recommend ]│  │
│ │                                   │ │ ------------------- │  │
│ │                                   │ │ Chat about setup ▸  │  │
│ └───────────────────────────────────┘ └────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

- **Stat cards** — session-wide rollups over the tuning session's laps: lap
  count, best lap, average (valid) lap, drive time (Σ lapTime), fuel/lap, tyre
  degradation. Cards with no data hide (never show 0), matching `SessionRecap`.
- **Tune-tests table** — one row per **setup version under test** (a "tune test
  event"). Expand → its laps with per-lap time (★ = fastest in the test), fuel/lap,
  tyre wear, and a spun flag 🌀. Min-3-laps guidance per test; more allowed
  (e.g. after a spun/thrown-away lap).
- **Right panel (live)** — the current stint summary as laps stream in:
  laps done vs the 3-lap minimum, best/avg, fuel/lap, tyre deg. A **comment box**
  (shared with the AI). **Save & recommend** runs the deterministic engine over
  the stint, writes the next setup version, and adds a new test row. A **chat**
  section to converse about the setup before generating — personalising the next
  tune (the driver has input, not just a button).

---

## 2. Data model

### `tuning_tests` (new table; = parity plan's `setupVersions`, session-scoped)
A tune test is one setup being evaluated within a tuning session.

`id, tuningSessionId (FK), version (int, 1..N), label (text — "base", "Front ARB −1"),
setupPath (text — the written setup file), parentTestId (int?), appliedChanges (json —
AppliedChange[]), driverComment (text?), engine (text — "rules"|"llm"), status
(active|archived), createdAt`.

- Created on session create: **v1 "base"** from the session's `baseSetupPath`.
- Created on every Save & recommend: **v(N+1)** with the applied diff + the setup
  file written by `writeSetupFile` (versioned mode, parity Phase 1).
- Hand-rolled migration **v24**.

### Lap ↔ test association (parity §4c)
Laps whose `createdAt` falls between a test's `createdAt` and the next test's,
within the session's car+track. Manual reassignment deferred. Live laps attach to
the **active** test as they arrive.

### Per-lap metrics (tyre / fuel) — new server compute
`LapMeta` has no tyre/fuel. Derive per lap from the stored telemetry frames:
- **fuel/lap**: available — ACC `fuelLitersPerLap` / F1 `fuelPerLap`, else Δ fuel
  across the lap's frames.
- **tyre wear/lap**: **availability caveat** — ACC shared memory exposes tyre
  temp/pressure but not a clear wear channel; if absent, show "—" and drop the
  Tyre card rather than fake it. Confirm against a real ACC stint before wiring.
- **spun**: from a spin detector (parity Phase 2 — `spin` kind, not yet built;
  until then, infer from a large yaw-rate/heading swing or mark manually).

Endpoint: `GET /api/tuning-sessions/:id/lap-metrics` → per-lap
`{ lapId, testId, time, fuelPerLap?, tyreWear?, spun? }`, decimated server-side.

---

## 3. Phases

### Phase A — tests backend (no UI yet)
- `tuning_tests` table + migration v24 + `tuning-test-queries.ts`
  (create/list-by-session/get). Seed v1 on session create (extend the create
  route to insert the base test).
- Endpoints on `tune-routes`: `GET /api/tuning-sessions/:id/tests`,
  `POST /api/tuning-sessions/:id/tests` (from a Save & recommend result).
- Unit tests (mirror `tuning-sessions.test.ts`).

### Phase B — workspace layout (live-first)
- New `TuningSessionWorkspace.tsx`, rendered by `TuneDashboard` when
  `tuningSession` is set (replaces today's passthrough to `TuneWorkspace`).
  `useTuningSession(id)` + `useTuningSessionTests(id)` hooks.
- **Stat cards** from the session's laps (reuse `useLaps` filtered by the
  session's car+track/time window; a `StatCard` in the repo's card style).
- **Tune-tests table** (reuse `AppTable`) with expandable per-lap rows fed by the
  lap-metrics endpoint.
- **Right panel** live summary from the telemetry store (as `TuneLiveDashboard`
  does) + comment box + **Save & recommend** button → calls the existing
  deterministic autotune (`useSetupEngineer`/`useAutoTune`, `engine:"rules"`,
  `driverNotes` = comment), then `POST …/tests` to record v(N+1). Reuses
  `writeSetupFile` versioned mode.
- Review-secondary: a live/review toggle picks the active test's laps from a past
  stint instead of the live feed (shares cards + table).

### Phase C — per-lap metrics compute
- `lap-metrics` endpoint deriving fuel/lap (+ tyre wear if the channel exists;
  else omit). Wire into the table + cards. Validate tyre-wear availability on a
  real ACC + AC-Evo stint first.

### Phase D — setup chat (personalisation)
- Reuse the chat-agent infra (`server/ai/agents.ts` chat agent, `chats` routes)
  with a tune-scoped system prompt: context = current setup, the stint's
  symptoms (`telemetryToSymptoms`), applied history, and the driver's comment.
- Chat UI in the right panel. The driver can discuss the car, then ask the AI to
  generate the next tune. Chat outcome feeds `driverNotes`/intent bias — the LLM
  never picks raw numbers (parity §4d); deterministic rules still own the maths,
  LLM explains/steers.

---

## 4. Conventions / risks
- Server-side compute; client renders compact JSON (CLAUDE.md). Live summary from
  the WS store, not polling. New table via hand-rolled migration. Setup writes via
  `writeSetupFile`'s guarded base dir. gameId via body/`GameIdSchema`.
- **Risk — tyre wear**: may be unavailable for ACC; degrade gracefully (hide the
  card) rather than fake. Confirm early.
- **Risk — spun flag** depends on parity Phase 2 spin detection (not built);
  interim heuristic or omit.
- **Risk — lap↔test window** mislabels if the driver doesn't reload the new setup;
  manual reassignment is a later add.
- Save & recommend depends on parity Phase 1 versioned `writeSetupFile` (the
  `Base v2.json` mode) — build that alongside Phase A, or write `-vN` names in the
  interim.

## 5. First increment to build
Phase A (tests table + endpoints + v1 seed) **and** Phase B skeleton (workspace
with real stat cards + tests table + right-panel live summary + Save & recommend
wired to the existing deterministic engine). Tyre wear and chat come in C/D.
