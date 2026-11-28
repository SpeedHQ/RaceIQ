# Inline companion integrity checks

ADR: [Hash retained LMU opponent data inline](../adr/0018-inline-companion-sha256.md).

Restore the recorder’s inline digest update after successful companion admission. Remove the batch digest callback from the shared writer without changing partial-write handling. Leave the manifest and read paths unchanged.

| Criterion | Verification through the recording path |
|---|---|
| A1: Intact retained captures replay exactly. | Write native LMU frames, stop, hash the companion independently, compare the manifest digest, and replay the original frames. |
| A2: Failed companion writes do not publish a valid prefix. | Exhaust the companion queue, stop, verify incomplete retention and replay the player frames. |
| A3: Removing the callback preserves vectored output. | Force short filesystem writes across batch boundaries, close, and compare the file with the submitted bytes. |

Run `opponent-recorder-safety.test.ts` and `preopened-file-writer.test.ts` for these criteria. The [paced benchmark](../contributing/performance-benchmarks.md#decision-inline-sha-256-for-retained-lmu-opponents) records the performance evidence separately.
