# Race Event Timeline

RaceIQ maintains one authoritative, durable race-event timeline for each telemetry session. The timeline is the common racing-fact boundary for live UI, imported recordings, raw rebuilds, lap quality, and materialized race results. Consumers query or subscribe to these canonical events rather than detecting pit visits, flags, incidents, or source failures again.

## Contract

The browser-safe contract is `shared/racing/events/contracts.ts`. `RaceEvent` is a versioned discriminated union with a strict payload for every `RaceEventType`. Each record includes:

- session, participant, driver, team, lap, track, and source-time anchors when the source proves them;
- deterministic timeline coordinates (`timelineEpoch`, `sequence`, `eventOrder`);
- evidence (`observed`, `derived`, or `inferred`), confidence, and quality state;
- source and detector provenance;
- optional lifecycle and event links; and
- a stable event ID plus a semantic content hash.

Payloads contain facts and normalized units, not user-facing sentences. Display labels belong to clients and therefore cannot change event identity. Missing source facts remain nullable or unknown; absence is not evidence for a clear, exit, completion, or retirement.

## Detector ownership and order

`server/race-events/coordinator.ts` is the only coordinator for semantic event detection. Game adapters translate normalized telemetry into `RaceEventObservation`; focused detectors then own separate fact families:

| Priority | Owner | Examples |
|---:|---|---|
| 0 | Source quality | reconnects, gaps, duplicates, storage failures |
| 10 | Session and race control | session phases, flags, timebase resets |
| 20 | Participant | joins, availability, returns |
| 30 | Driver | stint starts and driver changes |
| 40 | Lap | starts, completions, sectors, invalidation |
| 50 | Pit visit | entry, stall arrival/departure, exit, incomplete visit |
| 60 | Pit service | tire, fuel, repair, and driver service |
| 70 | Incident, damage, penalty, and reset | direct or threshold-backed observations |

Detectors do not write SQLite or WebSocket messages. The coordinator validates their drafts, assigns deterministic same-observation order, and hands completed records to the store. Unknown observations do not clear prior known state. Inferences are emitted only when their documented evidence threshold is met and carry `evidenceKind: "inferred"`.

## Identity, ordering, and conflicts

Canonical event order is `(timelineEpoch, sequence, eventOrder, eventId)`. `sequence` is the accepted observation ordinal within an epoch, not database insertion order. A reset or reconnect starts a new epoch before native sequence rejection, so valid reset packets cannot be mistaken for out-of-order input.

Stable IDs are SHA-256 identities over semantic boundary coordinates: schema version, local session ID, participant, epoch, event type, detector, boundary key, and lifecycle identity. Detector algorithm version is deliberately excluded. The content hash covers factual event content but excludes database lap links, receipt generations, receive time, and creation time.

An existing ID with the same content hash is an idempotent no-op. An existing ID with different semantic content is a conflict. Live append rejects the conflict; a full rebuild may replace an event only under the detector-version conflict rules after validating the complete candidate set.

## Lifecycle identity and links

Lifecycle IDs identify episodes rather than individual events. The coordinator derives each ID from the opening event's semantic coordinates: session, participant when applicable, epoch, opening event type, detector, and detector boundary. The opening event ID is then derived from that lifecycle ID. Event IDs never feed lifecycle identity, which avoids a circular digest and makes replay reproduce both identities.

Supported paired episodes are `caution_started` / `caution_ended`, `damage_warning_started` / `damage_warning_cleared`, `penalty_issued` / `penalty_cleared`, `source_stale` / `source_recovered`, and `source_connected` / `source_disconnected`. Events in one episode share the opening lifecycle ID. A proven closing event sets `linkedEventId` to the opening event ID. Source freshness and source connection are separate episodes, so a timeout does not replace the connection lifecycle.

Pit detector lifecycle IDs remain stable for the whole visit. When an emitted opening pit event exists, later visit and service events link to that opening event while retaining the detector-owned visit ID. A visit first observed in an unsupported or unknown state is not given a fabricated opening link.

Epoch and session resets clear active lifecycle state. Participant disappearance also clears participant-scoped damage, penalty, and pit state. A reconnect carries the immediately preceding stale opening across the epoch boundary only long enough for `source_recovered` to close it; the independent source connection remains open until proven `source_disconnected`. A close without known opening evidence keeps both lifecycle and event links null.

## Live, import, and raw rebuild flow

The live path is serialized around normalized observations:

1. Record the source frame and normalize the parsed packet.
2. Preflight native coordinates, lifecycle evidence, duplicate/out-of-order state, and epoch changes.
3. Feed accepted observations to lap detection and focused race-event detectors.
4. Validate and append completed events with affected lap/quality projections in one transaction.
5. Publish `race-events-appended` only after the append commits.
6. Finalize lap links and materialized results before their corresponding invalidations.

Session import uses the same `LiveTelemetryPipeline`, adapters, lap detector, and coordinator, so it does not have an import-specific event detector.

Raw `.bin` and `.bin.gz` rebuild stages normalized observations, laps, events, linked quality, and the materialized result in memory. It validates the full staged state, then replaces replayable state in one transaction. Only successful activation publishes `race-events-replaced`. A failed rebuild leaves the previous laps, events, quality, and result intact.

There is no process-local replay cache. A client reconnects or refreshes by querying the durable session timeline.

## Persistence and query API

`race_events` is session-owned storage. Session deletion cascades to events; deleting a linked lap or event clears the corresponding nullable link. Simultaneous events may share epoch and sequence, so ordering always includes `eventOrder` and `eventId`.

`server/db/race-event-queries.ts` owns runtime row validation, append/replacement transactions, generation finalization, and ordered list queries. The typed route is:

```text
GET /api/sessions/:id/events
```

`gameId` is required and must match the session owner. Remaining filters are intersecting: `participantId`, `lapNumber`, `fromSourceTimeMs`, `toSourceTimeMs`, `eventType`, `lifecycleId`, and `qualityOnly`. Time filters use inclusive overlap with the event source-time range. Pages default to 200 events and allow at most 1000. `nextCursor` continues a non-terminal page; `tailCursor` identifies the final event returned even on a terminal page so reconnecting clients can request only later durable events. Both are opaque base64url encodings of ordering tuples; consumers must not construct or interpret them.

WebSocket messages are hints that committed authority changed:

- `race-events-appended` includes the affected session and newly committed events;
- `race-events-replaced` identifies the session whose replayable timeline was atomically replaced.

Clients validate both messages with the shared schemas and invalidate only the affected session query. Missed messages are recovered through the cursor API.

## Result and quality projection boundary

Race results are materialized projections, not event authority. Result derivation reads canonical timeline events for pit count, service strategy, and supporting event IDs, while classification evidence remains result-specific. Reconciliation may rebuild a missing or stale replayable timeline from retained source evidence, but it does not maintain a second event ledger.

Lap classification, pit phase, quality facts, and tune findings consume canonical event context and preserve supporting `RaceEventId` values. They may attach domain judgments to events; they must not redetect the underlying racing transition from stored packet arrays.

## Interrupted sessions

Source disappearance is represented independently from a proven session end. `source_stale` opens a freshness episode, `source_recovered` closes it, and `source_disconnected` closes the separate connection episode. If a pit visit is open, finalization emits `pit_visit_incomplete`; it does not fabricate pit exit, service completion, or a terminal session. `session_ended` is emitted only when terminal evidence or an actual session rotation proves the boundary.

Transport and storage diagnostics survive replayable timeline replacement. Their lap links may be cleared or relinked as appropriate, but raw rebuild must not erase evidence that the original capture was interrupted or degraded.

## Archive and generation seams

Issue #232 will add canonical Parquet archive reading. That reader must adapt archive envelopes into the existing `RaceEventObservation` and call the same rebuild entry point; it must not add archive-specific event types or detectors.

Issue #233 now persists shared analysis receipts and active artifact generations. `session_analysis` receipt activation wraps existing whole-set replacement without changing event identity or payload contracts. Canonical archive availability trusts only a valid active receipt with complete verification checks and semantic inventory. See [Analysis provenance](analysis-provenance.md).

## Implementation map

- `shared/racing/events/contracts.ts` — event, query, page, and WebSocket schemas
- `server/race-events/coordinator.ts` — accepted observation ordering and detector orchestration
- `server/db/race-event-queries.ts` — durable append, replacement, and cursor queries
- `server/telemetry/live-pipeline.ts` — live/import activation ordering
- `server/session-capture/reprocess.ts` — raw rebuild staging and activation
- `server/routes/session-routes.ts` — typed session timeline route
- `client/src/components/race-events/RaceEventTimeline.tsx` — historical session presentation
