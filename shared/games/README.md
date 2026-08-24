# shared/games

Single source for game adapters, identity boundaries, and telemetry capabilities.

## Purpose
- Declare known game IDs and typed game contracts.
- Expose a unified adapter registry for client and server.
- Provide per-game adapters and static game-specific data catalog entries.

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
- `init.ts`
  - `initGameAdapters`
- `telemetry.ts`
  - `getFuelAmount`
  - `getFuelDisplay`
  - `getTireTemperatureSourceUnit`
- per-game adapters under `fm-2023/`, `f1-2025/`, `acc/`, `ac-evo/`, `iracing/`, `lmu/`
  - each exports a `...Adapter`
- `iracing/`
  - `index.ts` identity setter bridge: `rememberIRacingIdentity`, `injectDiscoveredIRacingIdentity`
  - `session-info/*` catalog, normalization contracts, and setup field definitions
- `lmu/`
  - `index.ts` deterministic string identity bridge for LMU car and track names

## Browser vs Node boundary
- Adapter objects and registry are browser-safe.
- `shared/games` itself contains no Node core imports.
- CSV/JSON catalogs in `shared/games/*` are static data files loaded by server-side layers such as `shared/racing/cars`, `shared/racing/tracks`, and `server/games/*`.

## Dependency direction
- Direction is core: `shared/games` defines contracts and adapters consumed by:
  - `shared/racing/cars` lookups
  - `shared/racing/tracks` shared-name mapping
  - `shared/racing/analysis` and UI analytics paths
  - `server/games/*` parser and adapter bridges
  - client and server code that resolves game IDs through the registry
- Runtime mutability is limited to adapter registration and explicit identity injection.

## Source-of-truth and regeneration
- `ids.ts`, adapter `index.ts` modules, and `types.ts` are the runtime source-of-truth for supported game behavior.
- Committed CSV/JSON files under each game folder are the runtime catalog source-of-truth; loaders do not fetch remote metadata at runtime.
- Regenerate only artifacts with a dedicated command:
  - `bun run iracing:cars:seed`
  - `bun run iracing:tracks:seed`
  - `bun run extract:cars:ac-evo`
  - `bun run extract:tracks:ac-evo`
- Forza, F1, and ACC track extraction commands generate track geometry under `shared/data/tracks`; they do not regenerate game catalog CSVs.
- Preserve CSV headers and native ordinals. Review generated diffs before committing.

## Add/extend safely
- Add new game:
  1. Add ID to `KNOWN_GAME_IDS` and `GameIdSchema`.
  2. Add adapter in a dedicated folder exporting `GameAdapter`.
  3. Register adapter in `initGameAdapters`.
  4. Wire server parser and car/track name resolvers in game-specific server layers.
- Keep imports explicit and leaf-scoped, e.g. `import { getGame } from "@shared/games/registry"`.
