---
name: raceiq-tire-core-ranges
description: "Change, add, or surface per-game/per-compound optimal tire temperature ranges in RaceIQ (metadata, channel core vs surface, cold-lap split, AI facts/tools, cars-page compound circles and dialog) and verify."
---

## Source of truth

- Metadata lives on `GameAdapter.tireTempOptimal?: { channel?: "core" | "surface"; default: Range; compounds?: Record<string, Range> }` in `shared/games/types.ts`. `channel` defaults to `"core"`.
- Values live in `packages/game-<id>-metadata/src/index.ts` (`acc`, `ac-evo`, `f1-2025` = core; `lmu` = surface, band mirrors its `tireTempThresholds` green band 70–105 °C). Forza/iRacing publish nothing.
- Resolver: `getTireTempGuide(gameId)` → `{ channel; rows: {compound,min,max}[] } | null`; `getTireCoreTempRange(gameId, compound)` only reads a `core` channel and otherwise falls back to `tireTempThresholds.cold/warm`. Both in `shared/racing/live/tire-thresholds.ts`.

## Consumers

1. Cold-lap split: `packages/race-strategy/server/lap-metrics.ts` `thermalState()` — needs a measured core; F1 `TireCarcassTemp*`, ACC/AC Evo `acc.tireCoreTemp`; never `TireTemp*`. Surface windows never apply.
2. Tire diagnosis: `server/ai/tune-tire-symptoms.ts` — per-corner `cold/optimal/hot` from the fitted compound (core channel only).
3. AI facts: `server/ai/tire-temp-guide.ts` `formatTireTempGuide(gameId)` (prints `optimal tire core|surface temperature`, cold-tire sentence only for core); tool `apps/backend/src/mastra/tools/tire-temp-guide.ts` (`get_tire_temperature_guide`), registered on lap-analyst, lap-chat, compare-engineer, compare-chat, setup-engineer, driver-coach. Also inlined in `buildKunosAiContext` and F1 `buildAiContext`.
4. UI: `packages/cars-catalogue/ui/cars/TireCompounds.tsx` — `TireCompoundDots` (coloured circles via `data-tire-compound` + `.tire-compound-wheel`) on car cards and `CarTireDialog` per compound range. Wired into `LMUCars`, `AccCars`, `AcEvoCars`, F1 `TeamCard`. Temp units come from the catalogue host `useUnits().temp`/`tempLabel`; never hardcode °C.

## Repo-specific traps

- `@raceiq/backend-core` exports are explicit in `server/package.json`; add a new `./ai/<name>` entry.
- `server/games/kunos/ai-context.ts` lives in `server/games/kunos/`, so import `../../ai/...`.
- Unit/integration suites need `initGameAdapters()` before any `getGame`/guide call; the client registers adapters in `client/src/main.tsx`.
- Catalogue message keys are a manual union in `packages/cars-catalogue/contracts/host.ts` (`CarsCatalogueMessageKey`); add the key there or `m.<key>()` fails typecheck.
- i18n: add keys to all `client/messages/*.json` preserving key parity (`bun scripts/i18n/check-message-keys.ts`), then `bun run --cwd client i18n:compile`. Remove keys no longer referenced.
- Test manifests: a new test file needs adding to `apps/backend/test/unit-files.txt`/`integration-files.txt`; prefer extending an existing listed file.
- E2E uses the compiled binary: `bun run build` before `E2E_SERVER_MODE=compiled` Playwright runs.
- AI prompts stay in canonical °C; user unit choice applies at UI presentation only.

## Verification

1. `bun run typecheck`.
2. `bun test --config bunfig.integration.toml apps/backend/test/setups/tuning/tune-symptoms.test.ts` (guide shape, channel wording, classification).
3. `bun test packages/race-strategy/test/unit/tire-thresholds.test.ts` and `bun test --config bunfig.integration.toml packages/race-strategy/test/integration/stint-strategy.test.ts`.
4. `bun run build`, then `cd playwright && E2E_SERVER_MODE=compiled PW_SERVER_SET=seeded bun ../scripts/playwright-ci.ts test --config=playwright.config.ts --project=seeded-e2e tests/seeded/landing/landing.spec.ts -g "dashboard recap"` — expects compound circles plus a dialog (5 F1 / 3 LMU / 2 ACC-AC Evo rows) on ACC/AC Evo/F1/LMU cars pages and no circles on FM/iRacing.
