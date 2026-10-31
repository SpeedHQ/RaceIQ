---
name: raceiq-bun-worker-rejection-matcher
description: Diagnose RaceIQ Bun 1.4.3 worker tests hanging at expect(promise).rejects despite production shutdown succeeding; preserve assertions using ordinary promise settlement.
---

# RaceIQ Bun worker rejection checks

Use when a worker-backed recording test times out but the equivalent production recorder flow succeeds outside `bun test`.

## Observed failure

On Bun 1.4.3, `apps/backend/test/session-capture/live-source-writer.test.ts` hung at `await expect(recorder.stop()).rejects.toBeInstanceOf(Error)`. Temporary diagnostics showed `ack`, `sync-ack`, and completion of the sync await, but no shutdown messages while the matcher waited. The equivalent `bun -e` flow received `durable` and `closed` and rejected normally.

## Procedure

1. Isolate the named test. Filesystem-only recorder tests can use the repository's `RACEIQ_UNIT_TESTS=1` switch to skip unrelated DB preload; do not use it for tests requiring database initialization.
2. If needed, temporarily log worker message types and the stages immediately before/after the pending await. Remove diagnostics afterward.
3. Settle the worker-backed promise with ordinary `await`, then assert the resulting error:
   ```ts
   const error = await recorder.stop().then(() => null, (error: unknown) => error);
   expect(error).toBeInstanceOf(Error);
   ```
   Preserve stricter original identity or message assertions. For deliberate worker termination, attach the rejection handler before terminating to avoid unhandled-rejection timing.
4. Do not increase timeouts, weaken assertions, or change production worker scheduling to hide this test-runner behavior.
5. Run the targeted regression suite and backend typecheck after edits.

## Verified commands

```sh
RACEIQ_UNIT_TESTS=1 bun test apps/backend/test/session-capture/live-source-writer.test.ts apps/backend/test/session-capture/live-worker-catchup.test.ts apps/backend/test/session-capture/live-worker-close.test.ts packages/tooling-release/test/changelog.test.ts --timeout 30000
bun check --build apps/backend/tsconfig.json
```

Observed result after assertion sequencing correction: 26 tests passed in about two seconds; previous runs timed out even with DB preload disabled. Treat this as a version-specific diagnostic, not proof that every worker timeout has the same cause.
