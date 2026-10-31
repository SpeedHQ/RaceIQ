---
name: raceiq-game-fact-plumbing
description: "Use when adding a per-game fact/range to RaceIQ (game metadata, AI tool/prompt, per-game UI page) — covers shared types, metadata adapters, Mastra tools, i18n parity, route tree, and E2E verification."
---

## When to use
Adding a per-game fact to RaceIQ that must be (a) canonical game data, (b) fetchable by AI, (c) visible in per-game UI.

## 1. Canonical data
- Add optional field to `GameAdapter` in `shared/games/types.ts` (import shared range types, no cycles).
- Seed values in `packages/game-<id>-metadata/src/index.ts`, with a source comment. Leave games without the underlying channel empty; do not invent values.
- Add a resolver + list helper in a `shared/racing/live/*.ts` module (e.g. `tire-thresholds.ts`): single lookup with explicit fallback, plus `getXGuide(gameId)` returning `[]` when absent. Use `tryGetGame` when a missing adapter must not throw.

## 2. AI
- Formatter in `server/ai/<topic>-guide.ts` (`format<X>Guide(gameId)`), export path added to `server/package.json` `exports` (no barrel).
- Mastra tool in `apps/backend/src/mastra/tools/<topic>-guide.ts`: `createTool`, optional `gameId` input, fall back to `execCtx?.requestContext?.get("gameId")`.
- Register in relevant agents: lap-analyst, lap-chat, compare-engineer, compare-chat, setup-engineer, driver-coach.
- Also inline the formatted line in per-game `buildAiContext` (Kunos helper and F1) so prompts get it without a tool call.

## 3. UI
- Own page beats dashboard card when the user asks for a reference section: route `client/src/routes/$gameid/<segment>.tsx`, page component, sidebar entry in `FEATURE_LINKS` (`AppSidebar.tsx`) with a `requiresX` flag gating `visibleFeatures` and `supportedPageRoots`.
- Respect user units: `useUnits(gameId)` → `units.temp(value)`, `units.tempLabel`. Never hardcode °C in labels.
- Route tree `client/src/routeTree.gen.ts` regenerates via client typecheck/build.

## 4. i18n
- Edit all 16 `client/messages/*.json`; key sets must stay identical (`bun scripts/i18n:check-message-keys.ts`).
- Add keys by line-anchored bulk script, then `bun run --cwd client i18n:compile`.
- Keep unit out of message text when the unit is dynamic.

## 5. Tests + verification
- Unit/integration: resolver values, compound/fallback boundaries, formatter text, prompt-context line.
- E2E assertions live in existing suites (`playwright/tests/seeded/landing/landing.spec.ts`); assert nav link presence/absence, page heading, row counts, unit symbol, empty state for games without data.
- Playwright seeded uses the compiled binary: run `bun run build` before E2E.
- Command: `cd playwright && E2E_SERVER_MODE=compiled PW_SERVER_SET=seeded bun ../scripts/playwright-ci.ts test --config=playwright.config.ts --project=seeded-e2e tests/seeded/landing/landing.spec.ts -g "dashboard recap"`.
- Unit numeric arithmetic stays in unit/integration tests; E2E asserts structure/persistence only.

## Pitfalls
- `getGame` throws for unregistered adapters in isolated tests; call `initGameAdapters()` in the test file or use `tryGetGame`.
- Adding `server/ai/*` file without an `exports` entry breaks `@raceiq/backend-core/...` imports.
- Sidebar link label is the accessible name; E2E `getByRole("link", { name })` uses it.
