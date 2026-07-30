# E2E After Unit Tests Design

## Problem

The PR workflow currently runs `build-test` and `build-windows` in parallel. The Windows build can consume resources while unit tests are still running, and Playwright E2E currently depends only on `build-windows`.

## Design

Update `.github/workflows/build-test.yml` so the Windows build waits for the complete unit/build job:

```yaml
  build-windows:
    needs: build-test
```

Keep the existing Playwright dependency on `build-windows`. This creates the chain `build-test → build-windows → playwright`, so E2E starts only after unit tests pass and the Windows artifact is available. Existing artifact upload and reusable Playwright steps remain unchanged.

If `build-test` fails or is skipped, `build-windows` and downstream E2E do not run. If the Windows build fails, E2E does not run.

No Playwright test files or reusable workflow steps change; E2E coverage already exists in `.github/workflows/playwright.yml`.

## Verification

Run the full unit suite with `bun run test`. Parse the modified workflow YAML and assert `build-windows` depends on `build-test`, `playwright` still depends on `build-windows`, and the existing artifact input remains intact.
