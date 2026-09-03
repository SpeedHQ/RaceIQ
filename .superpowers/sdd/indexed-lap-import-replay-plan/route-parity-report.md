# Route parity report

## Status

- Added focused comparison-route batching coverage.
- Same-session request passes both IDs to one `getLapsByIds` call with `parallelSessionDecodes: true`.
- A/B request order is asserted directly; each missing-ID response preserves existing per-ID 404 wording.
- Cross-session route behavior was not separately exercised because route-level loader is intentionally mocked; cross-session decode batching is covered by `test/db/lap-read-batching.test.ts`.
- Parser materialization counters were not wired: no production instrumentation seam supports real assertions. Removed unused `test/support/parser-materialization-counters.ts` rather than retain misleading helper.

## Files

- `test/routes/lap-comparison-batching.test.ts`
- `.superpowers/sdd/indexed-lap-import-replay-plan/route-parity-report.md`
- Removed `test/support/parser-materialization-counters.ts` (unused instrumentation helper)

## Verification

Command:

```sh
bun test test/routes/lap-comparison-batching.test.ts test/db/lap-read-batching.test.ts --timeout 60000
```

Result: 4 passed, 0 failed.

## Concerns

Route tests validate loader contract and error/order behavior, while actual same-/cross-session decode implementation remains covered by DB batching tests.
