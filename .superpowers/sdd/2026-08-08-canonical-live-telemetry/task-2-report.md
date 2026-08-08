# Task 2 Evidence Report

## Deliverables

- Added `shared/telemetry/live/contracts.ts` with protocol version 1 wire contracts:
  - schema definition/message
  - frame message with canonical scalar values and sparse non-default state/freshness maps
  - subscribe/unsubscribe controls
  - subscription result
  - development-only native packet envelope
- Added `shared/telemetry/live/history.ts` with nullable-schema canonical semantic-ID keyed history.
- Added `test/telemetry/live-contracts.test.ts` focused JSON round-trip and discriminator coverage.

## Guard behavior

Strict guards require protocol version 1 and expected discriminators. Frame guard rejects non-finite sequence, observed timestamp, or received timestamp values and rejects value arrays whose length differs from an available schema. Native dev packet guard requires a string `gameId` and finite numeric `TimestampMS`. Native packet type is referenced only by the development message contract.

## Verification

Command:

```sh
DATA_DIR="$PWD/.data-test" bun test test/telemetry/live-contracts.test.ts --timeout 30000
```

Result: 4 tests passed, 0 failed, 17 expectations. JSON stringify/parse round trips covered schema, frame, controls, subscription result, and native dev packet; tests assert encoded payloads contain no bigint marker and guards reject invalid protocol/version/shape cases.
