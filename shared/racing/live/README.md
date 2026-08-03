# Live telemetry

Live telemetry envelope types for socket-driven session display.

## Purpose
- Define wire-shape for per-sector and pit-strategy live snapshots.
- Keep UI/server type expectations identical for streamed live feeds.

## Key modules
- `types.ts`
  - `LiveSectorData`
  - `LivePitData`
- `status.ts`
  - `ServerStatus`

## Browser vs Node boundary
- Pure DTOs, browser-safe.
- Consumers must supply values (server producers read live packets, client components render them).

## Dependency direction
- Uses `SessionMeta` type from `../sessions/types` for status current-session field.
- Consumed by:
  - server runtime stream providers (`server/telemetry/*`, `server/live-strategy/*`)
  - client stores/components (`client/src/stores/telemetry.ts`, `client/src/components/telemetry/*`, dash views)

## Add/extend safely
- Add fields only after producer and consumer updates in same cycle.
- For optional additions, prefer nullable/optional fields first; avoid mandatory contract shifts.
- Keep one source of truth for derived values and avoid calculating from UI side in two places.
- Import directly by path, e.g. `@shared/racing/live/types`.
