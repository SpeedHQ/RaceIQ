# Task 2 Report: Enable two-worker CI execution and preserve streaming output

## Changes

- Added `PW_WORKERS: "2"` to both reusable workflow Playwright step environment blocks in `.github/workflows/playwright.yml`:
  - `Check Playwright project discovery`
  - `Run Playwright gate`
- Preserved existing `PLAYWRIGHT_PROJECTS` inputs and wrapper commands.
- Preserved combined CI reporter in `playwright/playwright.config.ts`: `[["list"], ["github"]]`.

## Verification

Executed from `playwright/` with isolated seeded ports and data directory:

1. `CI=1 E2E_SERVER_MODE=dev PW_SERVER_SET=seeded PW_WORKERS=2 PW_SEEDED_E2E_PORT=3220 PW_SEEDED_E2E_CLIENT_PORT=4220 PW_SEEDED_E2E_UDP_PORT=16320 PW_SEEDED_E2E_DATA_DIR="$PWD/test-results/test-data-seeded-local-parallel" PLAYWRIGHT_PROJECTS="--project=seeded-e2e" bun run ../scripts/playwright-ci.ts test seeded/settings/ai.spec.ts seeded/settings/persistence.spec.ts`
   - Passed (exit 0).
   - Exercised seeded E2E with two workers and streamed list reporter output.

2. `CI=1 E2E_SERVER_MODE=dev PW_SERVER_SET=seeded PW_WORKERS=2 PW_SEEDED_E2E_PORT=3220 PW_SEEDED_E2E_CLIENT_PORT=4220 PW_SEEDED_E2E_UDP_PORT=16320 PW_SEEDED_E2E_DATA_DIR="$PWD/test-results/test-data-seeded-local-parallel" PLAYWRIGHT_PROJECTS="--project=seeded-imports" bun run ../scripts/playwright-ci.ts test seeded/sessions/import.spec.ts`
   - Passed (exit 0).
   - Exercised `seeded-imports` project, which retains its one-worker cap, with streamed list reporter output.

Repository checks:

- `bun run typecheck:scripts` — passed (exit 0).
- `git diff --check` — passed (exit 0).

The full compiled CI gate was not run because no compiled `dist` artifact was available in this workspace (the repository root has no `dist` directory). The brief makes this gate conditional on compiled artifacts being available; targeted local smoke coverage and repository checks were run instead.

## Concerns

- Local smoke output included pre-existing server warnings (forced color / `NO_COLOR`, assertion stack diagnostics); both commands exited successfully.
- Windows CI execution remains platform-dependent and requires the workflow's configured Node/Bun environment from the broader plan.

## Review correction

- Clarified compiled-gate decision: artifact availability was checked after review; no repository-root `dist` artifact was present, so conditional compiled-gate execution was unavailable.
- Covering checks remain unchanged and passed: both isolated seeded smoke commands, `bun run typecheck:scripts`, and `git diff --check`.
