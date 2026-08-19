# Task 3 Report: Split CI Across Runners

## Status
Implemented Task 3 workflow changes.

## Changes

- Replaced the single reusable Playwright PR-gate call with four `strategy.matrix.include` legs and `fail-fast: false`:
  - `fresh`: `server-set: fresh`, `--project=fresh-install`
  - `tunes`: `server-set: tunes`, `--project=tunes`
  - `seeded-imports`: `server-set: seeded`, `--project=seeded-imports`
  - `seeded-read`: `server-set: seeded`, `--project=seeded-e2e --project=mobile-device --project=tablet-device`
- Passed matrix-specific server sets and project selections into the reusable workflow.
- Set unique per-leg artifact names: `playwright-${{ matrix.name }}` and `server-diagnostics-${{ matrix.name }}`.
- Added reusable `diagnostic-artifact-name` input, defaulting to `server-diagnostics`, and used it for server diagnostic uploads.
- Changed reusable workflow runner defaults and release caller runner labels to `['whitesmith-windows-x64', '4VCPU', '5G']`.
- Preserved existing Bun/Node setup, wrapper commands, `PW_WORKERS=2`, combined reporter behavior, project definitions, and artifact paths.

## Verification

Ran only required checks:

```text
ok .github/workflows/playwright.yml
ok .github/workflows/playwright-dev.yml
ok .github/workflows/release.yml
```

`git diff --check` passed with no output.

## Constraints

No broad test suites were run. No push performed; controller handles push and CI verification.
