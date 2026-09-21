# Opponent Callout Capabilities and Phasing

- Status: Accepted
- Date: 2026-09-21

## Context

Opponent callouts depend on several separate capabilities. A single label such as “available” is unsafe because a game may expose a live source without retaining it for replay, may have a detector without production enablement, or may have recorded player telemetry without opponent evidence. Every capability claim in this decision therefore names its status: **source available**, **recorded/replayable**, **detector implemented**, **production enabled**, or **unavailable**.

Current release contract is two-part: `RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER=true` must be set, and the game must be included in `RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS`. Under that contract, opponent pace supports F1 25, ACC, and iRacing; production live spotter supports ACC and iRacing. The subsystem game sets and semantic requirements remain authoritative for runtime behavior.

This decision is bounded to opponent callouts and their telemetry prerequisites. It changes no runtime behavior, capture format, telemetry schema, feature flag, or release state. Persisted-session constraints and replay semantics are defined by [Session Engineer Replay and Semantic Availability](session-engineer-replay-and-semantic-availability.md); this decision links to that accepted source rather than copying its rationale.

## Decision

### Current capability matrix

| Game | Live opponent source | Recorded replay | Opponent pace | Spotter | Primary limit |
|---|---|---|---|---|---|
| F1 25 (`f1-2025`) | **source available** — `F1ExtendedData.grid` | **recorded/replayable** — raw UDP packet families can rebuild retained state, but sparse prefixes can fail closed | **detector implemented; production enabled** behind flags | **detector implemented; unavailable for production** — geometry detector exists, but game is not production-enabled for `live-spotter` | UDP history, validity, class, and geometry evidence must remain aligned and fresh |
| ACC (`acc`) | **source available** — `AccBroadcastExtension` joined to shared-memory player state | **unavailable** — canonical ACC capture excludes Broadcast UDP | **detector implemented; production enabled** behind flags | **detector implemented; production enabled** behind flags | Broadcast UDP is required for opponent identity, timing, and position; shared memory alone is player-only |
| iRacing (`iracing`) | **source available** — `IRacingExtendedData.competitors` plus SDK arrays/native `CarLeftRight` | **recorded/replayable** — v3 source frames retain SDK deltas and SessionInfo YAML; v2/IBT have limitations | **detector implemented; production enabled** behind flags | **detector implemented; production enabled** behind flags | Replay source version, YAML roster, native occupancy, and trustworthy track-location evidence vary |
| AC Evo (`ac-evo`) | **unavailable** — no complete opponent source | **unavailable** | **unavailable** | **unavailable** | No trustworthy source-backed opponent identity, timing, validity, or occupancy |
| FM 2023 (`fm-2023`) | **unavailable** — no complete opponent source | **unavailable** | **unavailable** | **unavailable** | Player-only telemetry; no stable competitor feed or adapter contract |

Minimum pace evidence is defined once for all supported implementations: player index and class; completed player lap, time, and eligibility; session type; aligned competitor index, identity, class, lap, pit, and time facts; plus game-specific validity, connectivity, and track-location requirements. Competitor arrays must be aligned and contain no more than 64 entries. Missing, stale, invalid, misaligned, or unsupported evidence fails closed.

### Phase 1

- **Status:** Accepted/current
- **Scope:** Capability contract, fail-closed rules, release gates, and live-versus-replay matrix for all five games.
- **Prerequisites:** Accepted replay/semantic-availability ADR; current `semantics.ts`, subsystem flags, and adapter schemas.
- **Game coverage:** F1 25, ACC, iRacing, AC Evo, and FM 2023 as listed in the matrix.
- **Completion evidence:** Claims match `semantics.ts`, subsystem flags, adapter schemas, and the accepted replay ADR.

### Phase 2

- **Status:** Planned
- **Scope:** Persist every source-backed input needed by callouts, beginning with ACC Broadcast data; old recordings remain player-only.
- **Prerequisites:** Capture and replay changes preserve accepted persisted-source constraints and fail-closed semantics.
- **Game coverage:** F1 25, ACC, and iRacing.
- **Completion evidence:** Saved F1 25, ACC, and iRacing sessions replay the same eligible opponent facts used live.

### Phase 3

- **Status:** Planned
- **Scope:** Validate completed-lap opponent pace for F1 25, ACC, and iRacing, and positional spotter for ACC and iRacing on actual game telemetry; enable each game only through existing flags.
- **Prerequisites:** Phase 2 evidence where replay is required; valid source-backed semantic inputs; existing release gates.
- **Game coverage:** Pace: F1 25, ACC, iRacing. Spotter: ACC, iRacing.
- **Completion evidence:** Text, audio, mute, exact-pace response, preemption, delivery status, and reset behavior are proven for each enabled game.

### Phase 4

- **Status:** Planned
- **Scope:** Promote only high-value source-backed adjacent-rival gap closing/growing, ACC driver swaps, and multiclass traffic.
- **Prerequisites:** Explicit rival relevance; cooldown and dedupe; pit, caution, and formation suppression; deterministic text/audio; no generic “every opponent completed a lap” speech.
- **Game coverage:** Relevant-rival and traffic sources only where game telemetry supplies required identity, timing, class, location, and validity evidence.
- **Completion evidence:** Each callout family demonstrates source-backed selection, suppression, deterministic rendering, delivery status, reset, and replay behavior where persisted evidence exists.

### Phase 5

- **Status:** Blocked
- **Scope:** Watched-opponent and rating features.
- **Prerequisites:** User watch selection and trustworthy game-provided rating data.
- **Game coverage:** Only games meeting both prerequisites.
- **Completion evidence:** A game-specific source and user selection are proven end to end; never infer either from names, positions, or generic CrewChief catalog coverage.

## Consequences

CrewChief catalog coverage remains reference inventory, not a spoken-output promise. Missing, stale, invalid, misaligned, or unsupported opponent evidence continues to fail closed; RaceIQ creates no synthetic opponents and does not widen capability claims.

Phases 2–5 do not become shipped behavior by appearing in this ADR. Each requires its stated evidence and the existing release gates. Any adapter, capture, semantic requirement, supported-game set, or release-state change must update this ADR matrix in the same change.
