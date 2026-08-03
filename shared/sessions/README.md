# shared/sessions

Canonical session and lap DTOs shared by ingest, storage, and UI.

## Purpose
- Define persisted session/lap metadata shapes.
- Keep recap summaries, sector metadata, and source flags consistent across db, API, and UI.
- Provide stable types for session route payloads and analysis queries.

## Key modules
- `types.ts`
  - `LapMeta`
  - `SessionMeta`
  - `SessionRecap`

## Browser vs Node boundary
- Plain TypeScript contracts, browser-safe.
- No runtime side effects.

## Dependency direction
- Depends on
  - `../games/ids`
  - `../telemetry/version`
- Consumed by:
  - server persistence and query layers (`server/db/*`, route handlers)
  - client displays and selectors (`client/src/components/*`, hooks)

## Add/extend safely
- Treat as schema-shaped shared contract; update together:
  - DB migration layer
  - row mapping code
  - serializer/deserializer in query outputs
- Add new fields as optional/nullable to preserve older stored payloads.
- For `source` and `experiment*` fields, keep null semantics documented in field comments.
- Keep imports explicit by leaf module path.
