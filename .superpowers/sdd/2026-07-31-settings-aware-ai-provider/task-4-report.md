# Task 4 report: migrate AI consumers to feature resolver

## Status

Complete. Commit: `refactor: migrate AI consumers to feature resolver`.

## Delivered

- Migrated lap analysis, lap analyst consultation, auto-tune intents, driver profiles, and compaction to `resolveAi(feature)` request-local operations.
- Migrated lap chat, compare chat, and tune chat Codex handling to capability-based `ai.createChatResponse(...)`; non-Codex Mastra agent/tool paths remain intact.
- Preserved structured parsing at analysis, comparison, tune-intent, and driver-profile boundaries, including comparison-analysis rejection when the resolved chat capability identifies Codex.
- Removed consumer-level provider switches, direct secret access, environment mutation, provider-specific model fallbacks, direct Codex imports, and local OpenAI request duplication.
- Added `test/ai-consumer-resolution.test.ts` covering dedicated settings for analysis, chat, auto-tune, driver profile, compaction, plus auto-tune fallback to analysis settings.
- Added explicit `MastraProviderConfig` overload to `mastra/model.ts` for legacy Mastra-backed model mapping.

## Verification

- `bun test test/ai-consumer-resolution.test.ts test/codex-provider.test.ts test/provider-error.test.ts --timeout 30000`
  - 17 pass, 0 fail, 23 assertions.
- `bun test test/lap-route-game-id.test.ts test/analysis-telemetry.test.ts test/compact-route.test.ts test/driver-profile-runner.test.ts --timeout 30000`
  - 15 pass, 0 fail, 30 assertions.
- `bun test test/ai-consumer-resolution.test.ts test/codex-provider.test.ts test/provider-error.test.ts test/compact-thread.test.ts test/driver-profile-runner.test.ts --timeout 30000`
  - 27 pass, 0 fail, 47 assertions.
- Focused TypeScript check reports only pre-existing unresolved `@shared/*` aliases in `server/motec/*` and `server/lap-quality.ts`; no diagnostics in migrated files.
- `git diff --check` passed.
- Consumer audit found no `getSecret`, `process.env`, `runCodexCli`, `createCodexChatResponse`, `getConfiguredAiProvider`, provider-ID comparisons, or model fallback expressions in migrated consumers/routes.

## Concerns

- Non-Codex chat continues through Mastra agents to preserve tools, memory, and detached streaming; Codex uses the shared resolver capability. Full generic direct chat would remove those Mastra capabilities and was not introduced.
- Focused TypeScript invocation remains blocked by unrelated path-alias diagnostics listed above.

## Review fixes

- Restored Lap Analyst Mastra generation for non-Codex analysis consumers, preserving registered analysis tools; Codex remains on resolver execution via capability detection.
- Restored compare-engineer persona, units, language, and JSON contract as request-local system instructions for resolved comparison analysis.
- Wrapped chat resolver failures in explicit 400 provider-error responses across lap, compare, and tune chat routes.
- Added regression coverage for comparison persona/settings and typed missing-provider resolution errors.
- Review-fix focused suite: 29 pass, 0 fail, 51 assertions.

## Final review fix

- Bound non-Codex Lap Analyst Mastra execution to resolver-selected analysis provider/model through request context; agent tools remain available without reading general settings.
- Bound consult Lap Analyst execution through the same request-context configuration.
- Added analysis-vs-chat settings regression coverage.
- Final route/consumer focused suite: 13 pass, 0 fail, 28 assertions.
