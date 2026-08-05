# Task 1 report

Implemented shared `generateLapAnalysis` service and switched lap analysis route to use it.

Files changed:
- `server/ai/generate-lap-analysis.ts`: centralized lap lookup/preparation, corner fractions, tune/setup context, provider/key setup, model generation, JSON/schema validation, cache lookup, persistence, and structured result/error contract. Added generation seam through optional `deps.generate`.
- `server/routes/lap-routes.ts`: route now acts as HTTP/NDJSON adapter and delegates generation; preserves cache-only, status, and response fields.

Design decisions:
- Valid JSON cache is reused unless regeneration requested; malformed cache is ignored.
- Both JSON extraction and `AnalystOutputSchema.safeParse` must succeed before persistence.
- Generation failure returns error without calling `saveAnalysis`, preserving prior cache.

Verification:
- `bunx tsc --noEmit --pretty false --incremental false` was run; repository has pre-existing errors. Filtering for affected files found only existing shifted `lap-routes.ts` sector-shape error at line 643; no `generate-lap-analysis.ts` diagnostics.

Concerns:
- The repository-wide TypeScript check still reports unrelated pre-existing diagnostics.


## Fix report

Review findings addressed:
- Moved model generation back inside the NDJSON response stream, restoring 200-second heartbeat pings and terminal streamed error events.
- Restored `resolveAi("analysis", settings)` validation and request-scoped structured generation.
- Added focused `test/generate-lap-analysis.test.ts` covering valid cache reuse, missing laps, malformed/schema-invalid output, explicit regeneration, and failed regeneration preserving the prior cache.
- Restored `GET /api/laps/:id` `X-Game-Id` validation, lap/game matching, and native sector handling.
- Cached analysis is now reused only after `AnalystOutputSchema.safeParse` validation.

Verification:
- `bun test test/generate-lap-analysis.test.ts --timeout 30000` — 5 pass, 0 fail.
- Full TypeScript check remains blocked by pre-existing repository diagnostics; affected-file output has unrelated existing `lap-routes.ts` and project errors.