# Dev-Server PR E2E Design

## Problem

PR CI currently builds a Windows executable solely to run Playwright `fresh-install` and `tunes` E2E. This is slow and couples PR application coverage to Windows packaging. The E2E tests should run after unit tests without requiring the Windows artifact.

## Design

Use a dedicated dev-server Playwright workflow for PRs:

1. `build-test` remains responsible for client build and unit tests.
2. A new `playwright-dev` reusable workflow job depends on `build-test`.
3. The PR workflow no longer runs `build-windows` or compiled-binary Playwright.
4. Release workflow keeps the existing Windows compiled-binary Playwright path unchanged.

Add `.github/workflows/playwright-dev.yml` as a reusable workflow running on Ubuntu. It checks out the repository, installs Bun dependencies and Chromium, then runs the existing `fresh-install` and `tunes` projects.

Add a dev E2E launcher that:

- wipes and seeds each isolated test data directory using the existing safety rule;
- starts `server/index.ts` with each test's `SERVER_PORT`, `UDP_PORT`, and `DATA_DIR`;
- starts Vite from `client/` on a separate port with its API/WebSocket proxy targeting that backend;
- forwards termination to both child processes.

Update Playwright configuration so `fresh-install` and `tunes` use the Vite ports in dev-server mode. Existing compiled-server configuration remains available for release E2E. Tests and data isolation stay unchanged.

## Sequencing

PR graph becomes `build-test → playwright-dev`. Windows packaging and compiled E2E are removed from PR execution but remain available through the release workflow, which already passes `raceiq-dist-windows` to the compiled Playwright workflow.

## Verification

- Run `bun run test`.
- Run the dev Playwright `fresh-install` and `tunes` projects locally against the launcher.
- Parse all changed workflow YAML.
- Assert PR workflow has `build-test → playwright-dev` and no Windows build dependency, while release still passes its artifact to compiled Playwright.
