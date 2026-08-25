# Task 6 report

## Workflow changes

- Kept PR and base checkouts separate; removed any benchmark-definition copying.
- Added four fresh benchmark rounds in ABBA order: base→PR, PR→base, PR→base, base→PR.
- Each checkout runs legacy `bun run bench` for informational microbenchmarks and process-isolated replay via `bun run scripts/quality/process-bench.ts --suite=replay --revision=... --processes=2 --warmups=2 --iterations=20 --output=...`.
- Replay reports use logical `base-N.json`/`current-N.json` names independent of execution order; legacy reports use separate `legacy-*` names.
- Added paired informational comparison excluding replay and replay comparison with median 10%, p99 25%, retained-heap 10% thresholds. Enforcement uses `--fail-on-regression`.
- Artifact uploads include every JSON report and all comparison Markdown files.
- No replay-io, SQLite, file, gzip, or benchmark-definition copy commands added.

## Validation

- Inspected resulting YAML structure and PowerShell step boundaries after edit.
- Confirmed command paths and comparator pair ordering match process runner and paired-report interfaces.
- Preserved `bun.lock` and did not run project-wide suites.

## Concerns

- CI runner must provide Bun 1.3.14 and support PowerShell native argument-array expansion (`@pairs`), consistent with existing Windows workflow shell.
