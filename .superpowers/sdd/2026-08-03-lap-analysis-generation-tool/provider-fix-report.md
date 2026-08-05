# Provider Fix Report

## Status

Implemented final review fixes for analysis provider binding.

## Finding 1 — direct Google provider dependency

- Restored `@ai-sdk/google` as a direct root dependency at `4.0.20`, matching `@ai-sdk/openai` and the current AI SDK package convention.
- Added the matching `@ai-sdk/google@4.0.20` package record and integrity entry to `bun.lock`.
- `bun install` completed successfully with no package changes after lock synchronization.
- Runtime smoke check imported `./mastra/model.ts`; its static `@ai-sdk/google` import resolved successfully.

## Finding 2 — request-scoped Lap Analyst model

- Changed `mastra/agents/lap-analyst.ts` model callback to `({ requestContext }) => getModel("analysis", requestContext)`.
- This preserves normal chat behavior while allowing `runAiStructured` / `generateLapAnalysis` request contexts to supply the already-resolved model and credentials.
- Added `test/analysis-provider-binding.test.ts`, asserting a request-scoped OpenAI model is selected instead of the unbound fallback.

Unlimited-sector behavior was not changed; the diff contains only provider/dependency wiring, regression coverage, and this report.

## Verification

- Focused tests: `bun test test/analysis-provider-binding.test.ts test/generate-lap-analysis.test.ts test/lap-analysis-generation-tool.test.ts test/lap-analysis-route.test.ts test/compare-engineer-tools.test.ts --timeout 30000` — **14 pass, 0 fail**.
- Runtime import: `bun -e 'const mod = await import("./mastra/model.ts"); ...'` — **passed**.
- Scoped Prettier: `bunx prettier --write mastra/agents/lap-analyst.ts test/analysis-provider-binding.test.ts package.json` — **passed**.
- Whitespace check: `git diff --check` — **passed**.

## Concern

`bun install --frozen-lockfile` still reports pre-existing lock drift (`1574 packages - 1573 packages`) and requests unrelated Storybook lock refreshes. Regular `bun install` succeeds and runtime resolution is verified; this frozen-lockfile warning is not caused by Lap Analyst code.

Commit: `fix: restore analysis provider binding`.
