# Final Fix Report

Date: 2026-08-03

## Scope

Addressed all four Important findings from final review of the lap-analysis generation tool wave.

## Fixes

1. **Regeneration HTTP parity**
   - `/api/laps/:id/analyse` now performs a non-generating preflight before constructing the NDJSON response stream, including when `regenerate=true`.
   - Missing laps, empty telemetry, and provider setup failures therefore retain the legacy JSON error body and HTTP status instead of becoming a streamed 200 response.
   - `cacheOnly=true` remains a non-generating cache probe unless regeneration was explicitly requested.

2. **Native iRacing sector context**
   - Shared generation now checks the game adapter's `nativeSectors` contract and calls `computeNativeSectorTimeline` with `getNativeSectorLayout` before the track-boundary sector path.
   - Native sector times and source-defined boundaries are passed into the analyst prompt; non-native games retain existing `computeLapSectors` behavior.

3. **Exact retrieval tool key**
   - Lap Chat and Compare Chat now expose retrieval as `get_lap_analysis`, matching the required instruction/tool key.
   - `generate_lap_analysis` remains unchanged and remains registered only on Lap Chat, Compare Chat, and Compare Engineer; Lap Analyst still does not expose generation.
   - Registration regression expectations now reject the old camel-case retrieval key.

4. **Cached-row schema validation**
   - `getLapAnalysisTool` now validates parsed cache rows with `AnalystOutputSchema`.
   - `null`, arrays, malformed JSON, and schema-invalid objects return unavailable results and cannot be presented as analysis, allowing generation fallback.
   - Added a lookup dependency seam so retrieval behavior is directly tested without database mutation.

## Regression coverage

- Direct HTTP request verifies `POST /api/laps/999999/analyse?regenerate=true` returns 404 JSON before streaming.
- Service tests cover regeneration preflight missing-lap/provider errors and native iRacing sector context.
- Retrieval tests cover `null`, arrays, and schema-invalid cache rows.
- Agent tool tests cover exact snake-case retrieval/generation registrations and Lap Analyst exclusion.

## Verification

- `bun test test/generate-lap-analysis.test.ts test/lap-analysis-tool.test.ts test/lap-analysis-generation-tool.test.ts test/compare-engineer-tools.test.ts`
  - 16 pass, 0 fail.
- `bun test test/lap-analysis-route.test.ts`
  - 1 pass, 0 fail.
- `bunx prettier --check` on all changed TypeScript files: passed.
- `git diff --check`: passed.

## Concerns

- No full project test suite or live-provider generation was run; verification is intentionally scoped to the requested regressions and changed-file diagnostics.
