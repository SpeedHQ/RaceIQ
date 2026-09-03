# Import oracle report

Implemented `test/session-capture/lap-index-import.test.ts` and test-only parser instrumentation.

## Commands/results

- `bun test test/session-capture/lap-index-import.test.ts --timeout 180000` — **2 pass, 0 fail, 72 expect() calls** (FM 2023 and F1 2025 committed gzip fixtures; runtime 6.02s).

## Coverage

- Indexed/full parser detector-facing fields are compared after existing telemetry normalization.
- Canonical imports assert source-frame scans and index samples occur while full packet materialization remains zero.
- Counter seam increments at actual import/replay operations: source index frame scan, parser-state prime, index projection return, full parser return.

## Fixture limitations

- Current oracle exercises FM 2023 and F1 2025 fixtures. ACC, AC Evo, and iRacing fixtures are inventoried but not imported here because no stable legacy persisted snapshot baseline is available in this worktree.
- Full persisted legacy-vs-indexed snapshot comparison across every game requires legacy import path/oracle, no longer present. Existing round-trip suite remains separate.
