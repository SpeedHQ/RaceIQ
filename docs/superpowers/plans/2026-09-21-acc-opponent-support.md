# ACC Opponent Support Update Plan

## Goal

Make ACC opponent data usable across live dashboards, Engineer Replay, and live engineer callouts without treating missing Broadcast data as valid telemetry.

## Current state

- Shared memory provides player telemetry.
- `AccBroadcastClient` receives entry-list and realtime competitor updates from ACC's Broadcasting Network Protocol.
- `AccBroadcastState` joins competitor identity and realtime updates by ACC `carIndex`.
- Live semantic projection exposes ACC competitor identity, class, lap, pit, location, speed, position, and last-lap fields when Broadcast data is present.
- Canonical ACCP recordings currently contain shared-memory triplets only; Broadcast UDP snapshots are runtime-only.
- Live spotter and opponent pace are implemented behind existing release flags.
- ACC has no full opponent grid in normal replay because replay has no persisted Broadcast source.

## Scope

Update ACC opponent support end-to-end:

1. Record source-backed Broadcast snapshots with ACC session captures.
2. Restore competitor arrays during replay using the same semantic projector used live.
3. Display ACC opponents in the live dashboard and Engineer Replay.
4. Preserve fail-closed behavior when Broadcast data is absent, stale, malformed, or misaligned.
5. Prove behavior with deterministic fixtures and an actual ACC session.

Out of scope: new CrewChief families, synthetic opponent values, changes to shared-memory physics capture, generic feature-flag replacement, or release enablement before acceptance evidence exists.

## Source and recording design

### Capture

- Keep shared-memory triplets as the player telemetry source.
- Capture Broadcast entry-list and realtime messages as a versioned sidecar stream associated with the same session capture.
- Preserve message ordering, source timestamps, ACC session index, and connection lifecycle.
- Store only source-backed competitor facts required by the semantic contract; do not serialize derived UI rows as a substitute for source data.
- Mark Broadcast capture availability in the session source profile.
- A recording with shared memory but no Broadcast sidecar remains valid player telemetry and explicitly opponent-unavailable.

### Replay

- Replay shared-memory triplets and Broadcast sidecar through one ordered session timeline.
- Rebuild `AccBroadcastState` before projecting each semantic frame.
- Join by `carIndex`; reject mismatched array lengths, duplicate car indexes, stale updates, and session-index changes without a reset.
- Preserve source freshness and availability state so replay does not convert source loss into clearance or zero-valued opponents.
- Keep the existing 64-competitor bound.

## Semantic contract

Required ACC opponent fields:

- `identity.player-car-index`
- `identity.player-car-class-id`
- `race.competitor.car-index`
- `race.competitor.driver-id`
- `race.competitor.driver-name`
- `race.competitor.car-class-id`
- `race.competitor.car-class-name`
- `race.competitor.laps-complete`
- `race.competitor.pit-status`
- `race.competitor.connected`
- `race.competitor.track-location`
- `timing.competitor.last-lap-time`
- `timing.competitor.last-lap-valid`
- `motion.competitor.position-x`
- `motion.competitor.position-y`
- `motion.competitor.position-z`
- `motion.competitor.speed`

Every required field needs aligned competitor indexing and explicit freshness. Missing or stale Broadcast evidence yields unavailable opponent capability, not an empty clear state.

## UI behavior

### Live dashboard

Add ACC opponent standings using the F1 grid interaction pattern:

- Sort by position.
- Show leader, player, and nearby competitors by default when grid is large.
- Provide `Show all` toggle.
- Display driver, class, position, gap, last lap, pit state, and connection state where available.
- Show source-unavailable state when Broadcast is not connected or data is stale.
- Do not show fabricated rows from shared-memory player data.

### Engineer Replay

- Reuse live opponent row shape and focused/full-grid behavior.
- Show source profile status: Broadcast captured, unavailable, stale, or malformed.
- Keep opponent data outside the sticky timeline card.
- Reserve bottom overlay space so the full opponent panel remains reachable.
- Do not expose an opponent table when replay contains no persisted Broadcast source.

## Capability and release behavior

- Keep current live feature flags unchanged.
- Report ACC opponent pace and spotter as source-available only when Broadcast evidence is current and aligned.
- Preserve existing production support claims only after replay and live acceptance gates pass.
- Update the opponent capability ADR, ACC adapter documentation, and Live Engineer documentation in the same change as any source, schema, or release-state change.

## Implementation phases

### Phase 1 — Capture contract

- Define versioned ACC Broadcast sidecar framing.
- Add session source-profile fields for Broadcast capture and limitations.
- Preserve raw entry-list and realtime messages with source timestamps.
- Add round-trip framing tests and interrupted-capture recovery tests.

**Completion evidence:** a recorded ACC session can prove whether Broadcast source was captured without inspecting process logs.

### Phase 2 — Replay projection

- Feed sidecar messages through `AccBroadcastState` during replay.
- Align sidecar updates with shared-memory frames and session boundaries.
- Preserve unavailable/stale/malformed states.
- Add deterministic fixture replay with multiple competitors, pit transitions, disconnects, and driver identity changes.

**Completion evidence:** replay emits the same eligible competitor facts as live for identical source inputs.

### Phase 3 — UI output

- Add ACC live opponent grid.
- Add ACC Engineer Replay opponent panel.
- Reuse common row formatting and focused/full-grid interaction.
- Add source-status diagnostics and no-data states.

**Completion evidence:** browser smoke test shows multiple ACC competitors, `Show all`, stale-source handling, and no nested panel scroll hiding lower rows.

### Phase 4 — Engineer acceptance

- Run live ACC shared memory plus Broadcast session.
- Verify opponent pace, positional changes, pit transitions, connection loss, and recovery.
- Verify mute, preemption, exact-pace response, replay seek, session reset, and source dropout behavior.
- Compare live and replay event evidence for same captured source.

**Completion evidence:** acceptance matrix passes with no fabricated competitor, false clearance, stale callout, or misaligned identity.

## Verification matrix

| Scenario | Required result |
|---|---|
| Multiple connected competitors | All aligned competitors available to UI and detectors |
| Entry-list arrives before realtime updates | Identity waits for valid realtime facts |
| Realtime update arrives before entry-list | No guessed driver/class identity |
| Competitor disconnects | Row becomes unavailable/disconnected after bounded freshness timeout |
| Malformed or unequal arrays | Entire affected competitor capability fails closed |
| Session index changes | Broadcast state resets; old rows do not leak |
| Shared memory continues while Broadcast stops | Player telemetry remains usable; opponent features become unavailable |
| Replay without sidecar | Explicit opponent-unavailable state |
| Replay with sidecar | Same eligible opponent facts as live |
| More than 64 competitors | Input rejected or bounded deterministically |
| Live dashboard toggle | Focused view and full-grid view match source order and positions |
| Engineer Replay sticky timeline | Timeline never covers final opponent rows |

## Files likely affected

- `server/games/acc/broadcast-client.ts`
- `server/games/acc/broadcast-state.ts`
- `server/games/acc/broadcast-protocol.ts`
- `server/games/kunos/pack-triplet.ts`
- `server/session-capture/`
- `server/telemetry/live-projector.ts`
- `server/live-strategy/live-engineer-semantic-input.ts`
- `client/src/lib/live-telemetry-view.ts`
- `client/src/components/acc/AccLiveDashboard.tsx`
- `client/src/components/dev/DevLiveEngineerReplay.tsx`
- `shared/telemetry/live/semantics.ts`
- `docs/reference/adapters/acc.md`
- `docs/architecture/decisions/opponent-callout-capabilities-and-phasing.md`

Do not change generated catalog files by hand. Regenerate them through the repository catalog workflow when semantic mappings change.
