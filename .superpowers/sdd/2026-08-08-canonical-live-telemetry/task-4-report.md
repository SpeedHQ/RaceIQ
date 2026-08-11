
## Verification

`DATA_DIR="$PWD/.data-test" bun test test/telemetry/live-projector.test.ts --timeout 30000`

Result: **4 pass, 0 fail, 10 expect() calls**.

Review fixes: definitions derived from resolved metadata; ACC/AC Evo wall-clock observation domain; pit typed LivePitData|null. Focused test remains 4 pass, 0 fail.

Rereview fixes: restored LiveProjection export and preserved sparse state/freshness propagation. Focused test: 4 pass, 0 fail.
