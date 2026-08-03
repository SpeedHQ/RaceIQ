# Import contracts

## Purpose
Environment-neutral contracts shared by import producers and consumers.

`motec.ts` owns the stable `sessions.source` marker for MoTeC-derived sessions and the client-visible support predicate for verified game mappings.

## Key module
- `motec.ts`
  - `MOTEC_SESSION_SOURCE`: exact persisted marker (`"motec"`) written by server importer and read by client session views.
  - `motecImportSupported(gameId)`: browser-safe support check. Current verified shared allow-list contains AC Evo only.

MoTeC binary parsing, game-specific channel conversion, persistence, and routes live under `server/motec/`, `server/games/<game>/motec.ts`, and `server/routes/laps/transfer-routes.ts`. This shared folder does not own importer implementation.

## Browser vs Node boundary
- Keep marker constants and support predicates portable: no Node, DOM, database, or file-system imports.
- Server writes the marker after import; browser reads it to separate approximate imported sessions from recorded sessions and gates import UI.
- MoTeC-derived paths are dead-reckoned and lack absolute world position. Consumers must preserve this distinction rather than presenting imported geometry as measured capture data.

## Dependency direction
- Server importer and client session UI depend on `shared/imports/motec.ts`.
- Shared contract must not depend on server transcoder, client components, database schema, or HTTP routes.
- Game-specific import capability remains validated by server target registry; shared predicate exposes only client support policy already verified by implemented mappings.

## Add/extend safely
1. Implement and verify a game transcoder under `server/games/<game>/motec.ts` and register it in `server/motec/targets.ts`.
2. Only after mapping verification, add the game ID to the support list in `motec.ts` so client UI matches server capability.
3. Keep `MOTEC_SESSION_SOURCE` stable because it is persisted and used by client filtering.
4. Add new import-format contracts as separate leaf modules; keep parsing and I/O in server domains.

## Leaf imports (no barrel)
Use direct file imports only.

```ts
import { MOTEC_SESSION_SOURCE, motecImportSupported } from "@shared/imports/motec";
```
