# Architecture Overview

RaceIQ is a Bun server and React client built around a shared, registry-based game model.

## System shape

```mermaid
graph LR
  Games[Raw game telemetry] --> Adapters[Game adapters]
  Adapters --> Resolver[Canonical resolver]
  Resolver --> Semantic[Semantic telemetry view]
  Semantic --> Pipeline[Telemetry pipeline]
  Pipeline --> Timeline[Race event coordinator]
  Timeline --> DB
  Pipeline --> DB[(SQLite + session recordings)]
  Semantic --> WS
  API[Hono API] --> DB
  DB --> API
  WS --> Store[Zustand telemetry store]
  API --> Query[TanStack Query]
  Store --> UI[React UI]
  Query --> UI
```

- `shared/` holds telemetry types, game metadata, and shared game adapters.
- `server/` owns telemetry ingestion, parsing, authoritative session computation, persistence, API routes, and WebSocket broadcast.
- `client/` owns navigation, presentation state, live telemetry rendering, and historical-data queries.
- HTTP and WebSocket traffic uses port `3117` by default. Forza and F1 telemetry use UDP port `5301` by default.

## Current game adapters

Five adapters are registered by `shared/games/init.ts` and `server/games/init.ts`:

| Game | Internal ID | Ingestion | Route prefix |
|---|---|---|---|
| Forza Motorsport 2023 | `fm-2023` | UDP packet parser | `/fm23` |
| F1 25 | `f1-2025` | UDP packet accumulator | `/f125` |
| Assetto Corsa Competizione | `acc` | Windows shared-memory reader | `/acc` |
| Assetto Corsa Evo | `ac-evo` | Windows shared-memory reader | `/ac-evo` |
| iRacing | `iracing` | Windows SDK/shared-memory source | `/iracing` |

Each shared `GameAdapter` owns identity, route prefix, telemetry capabilities, coordinate conventions, and car/track resolution. Each server `ServerGameAdapter` adds the ingestion source, parsing state, lap detector, and analysis context.

## Telemetry data flow

1. UDP sources enter through `server/runtime/udp-listener.ts`; native sources enter through their adapter-owned readers.
2. Adapter parsing produces typed `TelemetryPacket` values using each source's coordinate conventions. Native packets remain inside ingestion, recording, replay decoding, and explicit development diagnostics.
3. The canonical resolver maps direct, normalized, derived, simplified, structured, and unavailable source values to stable semantic IDs.
4. Normal runtime consumers receive the semantic telemetry view. They do not read packet fields or game extensions directly.
5. `server/telemetry/live-pipeline.ts` applies coordinate normalization, coordinates lap detection and canonical race-event detection, performs track calibration, and activates durable projections before notification.
6. Completed sessions, laps, and the authoritative race-event timeline are stored in SQLite; raw telemetry is retained through game-specific recording paths for replay and transactional rebuild.
7. `server/runtime/websocket-manager.ts` broadcasts the semantic live schema and frames plus post-commit race-event invalidation messages. Native packets require an explicit development subscription.
8. React components render live semantic state from the store. Historical consumers request semantic replay values through typed Hono RPC and TanStack Query.

Steps 3–4 define the enforced authority boundary. Static client/server contracts reject new packet-based normal consumers.

## Persistence and API

`server/db/schema.ts` is the typed schema reference. Runtime migrations are embedded in `server/db/migrations.ts` and applied at startup. `server/routes/index.ts` composes feature route modules under `/api`; the client uses `client/src/lib/rpc.ts` rather than untyped fetch calls.

## Boundaries

- Server is authoritative for telemetry-domain state such as lap boundaries, sector timing, the durable race-event timeline, pit estimates, and persisted session-result projections.
- Client may own presentation state, but must not duplicate authoritative telemetry calculations. See [Frontend contribution guide](../contributing/frontend.md).
- Game-specific behavior belongs in registered adapters; shared consumers resolve the active game and request semantic IDs instead of reading native packet fields.
- Native telemetry may cross the semantic boundary only for ingestion, source-quality measurement, durable raw recording, replay decoding, canonical archive construction/input hashing, or explicit development diagnostics.
- Pipeline dependencies are injected through `DbAdapter`, `WsAdapter`, and session-recorder adapters so focused code can use real, null, or capturing implementations.

## Related architecture

- [Lap detection](lap-detection.md)
- [Lap telemetry cache](lap-cache.md)
- [Race results](race-results.md)
- [Race event timeline](race-event-timeline.md)
- [Analysis provenance](analysis-provenance.md)
- [Setup Engineer](setup-engineer.md)
- [Telemetry recording](telemetry-recording.md)
