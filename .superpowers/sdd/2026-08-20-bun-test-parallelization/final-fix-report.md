
## Follow-up cwd verification

- `DATA_DIR="$PWD/.data-test" bun test test/runtime/runtime-options.test.ts --timeout 30000` — PASS: 4 passed, 0 failed; migrations completed.
- Runner now executes child from repository root while generated Bun config retains disposable suite root as absolute `root`, preserving repository-relative subprocess behavior and isolated discovery root.
