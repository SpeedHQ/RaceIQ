# shared/games

Shared game identity, adapter contracts, telemetry capability contracts, and mutable registration.

## Purpose
- Declare known game IDs and typed game contracts.
- Expose a unified adapter registry for client and server.
- Keep concrete adapters and catalogs outside shared contracts.

## Key modules
- `ids.ts`
  - `KNOWN_GAME_IDS`
  - `GameIdSchema`
  - `GameId`
- `types.ts`
  - `GameAdapter`
  - `TelemetryModel`
  - `AnalysisTelemetryModel`
- `registry.ts`
  - `registerGame`
  - `getGame`
  - `tryGetGame`
  - `getAllGames`
- `telemetry.ts`
  - `getFuelAmount`
  - `getFuelDisplay`
  - `getTireTemperatureSourceUnit`
- `metric-contracts.ts`: foundational capability defaults and semantic bindings
- Concrete adapters and committed CSV/JSON catalogs live in `packages/game-<id>-metadata/src/`.
- `packages/game-catalogs/src/games/init.ts` composes all metadata adapters with release-feature gating.
- iRacing and LMU identity injection lives in their metadata adapter leaves.

## Browser vs Node boundary
- Contracts, registry, and metadata adapter `index` leaves are browser-safe.
- Node catalog readers are separate metadata leaves; browser entry points never import them.
- `gameCatalogDir(gameId)` resolves source metadata beside its owner and installed catalogs under `data/games/<game-id>`.

## Dependency direction
- Metadata owners depend on shared contracts, never the reverse.
- Server game owners depend on their corresponding metadata owner.
- Cross-game catalog and setup composition lives in `@raceiq/game-catalogs`.
- Applications initialize adapters explicitly; closed single-game tests register only their real metadata adapter.
- Runtime mutability is limited to adapter registration and explicit identity injection.

## Source-of-truth and regeneration
- `ids.ts` and `types.ts` define shared identities and contracts; metadata `index.ts` modules define concrete adapters.
- Committed CSV/JSON files under `packages/game-<id>-metadata/src/` are runtime catalog sources; loaders never fetch remote metadata.
Regenerate supported seed data with:
  - `bun run iracing:cars:seed`
  - `bun run iracing:tracks:seed`
Preserve CSV headers and native ordinals. Review generated diffs before committing.

## Add/extend safely
- Add new game:
  1. Add ID to `KNOWN_GAME_IDS` and `GameIdSchema`.
  2. Add a metadata owner exporting a browser-safe `GameAdapter` leaf and separate Node catalog leaves.
  3. Register the adapter in `@raceiq/game-catalogs/games/init`.
  4. Wire server parser and car/track name resolvers in game-specific server layers.
- Keep imports explicit and leaf-scoped, e.g. `import { getGame } from "@shared/games/registry"`.
