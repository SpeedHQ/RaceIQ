# Telemetry

## Purpose

`server/telemetry` coordinates normalized live packets and persisted semantic replay. It preserves raw source frames for later analysis, feeds game-owned lap detectors plus live strategy trackers, and publishes packet and lifecycle updates through injected ports.

## Structure

- `live-pipeline.ts` owns live packet ordering, recorder rotation, lap callbacks, tracker feeds, WebSocket publication, and recording-quality accumulation.
- `normalization.ts` contains shared in-place packet normalization used by live and persisted decode paths.
- `replay.ts` resolves persisted lap packets into canonical semantic envelopes with capture provenance.
- `pipeline-ports.ts` defines database, recorder, WebSocket, and source-lifecycle evidence boundaries plus production and test adapters.

## Boundaries and invariants

Game adapters own parsing, detector construction, coordinate metadata, and game policy. Session capture owns binary framing, recorder implementation, and raw-capture identity. Database modules own persistence queries; runtime owns WebSocket delivery and process lifecycle.

Live processing order is intentional: persist the source frame when a recorder is active, normalize the packet, feed the detector, repair a recorder rotation with the same source frame, feed sector and pit trackers, then publish telemetry and development state. Raw offsets must continue to identify the first byte of the corresponding recorded frame. Detector callbacks must keep session-start, lap-complete, and lap-saved order.

Source lifecycle, packet ordering, gaps, reconnects, and writer drops become localized quality evidence for the affected lap or time range. They must not rewrite simulator structural validity or contaminate unrelated laps.

Imported-source verification and canonical RaceIQ recorder integrity are independent evidence. A verified original source cannot hide a corrupt or truncated canonical capture. Session finalization drains pending lap persistence before writing session-level generations or publishing quality updates.

Replay keeps persisted packet order and timestamps, advances native source frames in capture order, and emits canonical values detached from mutable decoder state. Replay must not expose local capture paths or reinterpret parser, catalog, resolver, or derivation versions.

## Testing

Use injected `DbAdapter`, `WsAdapter`, and `SessionRecorderAdapter` implementations to isolate live-pipeline behavior. Replay coverage should exercise raw native captures, including timestamp validation, requested semantic ordering, native-frame alignment, and provenance metadata.
