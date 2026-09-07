# RaceIQ Playwright suite

This suite owns route-level browser tests and screenshot evidence. It is separate from `client/playwright.config.ts`, which runs Storybook snapshot tests against isolated client components. Run this suite from `playwright/` so package scripts, relative server commands, and generated paths keep their expected working directory.

## Projects

| Project | Match | Server/data |
| --- | --- | --- |
| `fresh-install` | `fresh-install/**/*.spec.ts`, `responsive/workspaces.spec.ts` | Fresh compiled or dev app |
| `marketing` | `marketing/**/*.spec.ts` | `MARKETING_BASE_URL` (default `https://raceiq.localhost`) |
| `mobile-screenshots` | `responsive/mobile-screenshots.spec.ts` | Seeded app |
| `tunes` | `tunes/**/*.spec.ts` | Tunes app |
| `mobile-device`, `tablet-device` | `responsive/device.spec.ts` | Seeded app with Chromium device emulation |
| `seeded-e2e` | `seeded/**/*.spec.ts` | Seeded app |
| `record-demo` | `recording/demo.spec.ts` | Fresh app with GPU launch flags |

Config uses `tests/` as `testDir`; no specs belong at `tests/` root. Stateful projects stay ordered on one worker. Only seeded screenshot runs enable parallel screenshot workers.

## Commands and server modes

```sh
cd playwright
bun install
bun run typecheck
bun run build
bun run test                         # build, then full Playwright run
bunx playwright test --project=seeded-e2e
bunx playwright test --project=mobile-screenshots
E2E_SERVER_MODE=dev bunx playwright test --project=seeded-e2e
PW_SERVER_SET=fresh bunx playwright test --project=fresh-install
```

`E2E_SERVER_MODE` is `compiled` by default and accepts `dev` or `compiled`. Compiled mode launches `dist/raceiq` (`raceiq.exe` on Windows); build first. Dev mode launches Bun server and Vite client. `PW_SERVER_SET` accepts `all`, `fresh`, `tunes`, or `seeded` and limits web-server instances. `PW_SCREENSHOT_ONLY=1` omits tunes server; pair with `PW_SEED_SCREENSHOTS=1` for read-only parallel screenshot capture. Port and data overrides are `PW_FRESH_INSTALL_*`, `PW_TUNES_*`, and `PW_SEEDED_E2E_*` (`PORT`, `CLIENT_PORT`, `UDP_PORT`, `DATA_DIR`). `RACEIQ_APP_ROOT` overrides repository root for dev launcher subprocesses. `CI` controls retry/reporter defaults; `PW_SCREENSHOT_WORKERS` controls screenshot worker count.
Launchers and screenshot database seeding live together in `support/server/`. They resolve repository root from their deeper location before starting application processes.

## Data safety and generated output

Launchers create configured E2E data directories and delete only their SQLite database files at startup. They preserve non-database fixture files and do not perform teardown cleanup. Seeded tests share one isolated server per shard; tests that mutate notes, imports, sessions, or settings must restore their own state. CI containers are disposable.

Playwright output goes to `playwright/test-results/`. Responsive captures go to `playwright/screenshots/` (mobile captures under `screenshots/mobile/`). Both are generated artifacts and must not be committed. Seeded data under `test-results/` is disposable.

## Adding coverage

Add a spec under its domain in `tests/` and update the matching project only when its path or server needs differ from existing definitions. Keep project names, test titles, assertions, serial/stateful behavior, cleanup, and generated locations stable when moving coverage. Put reusable browser assertions/data in `tests/support/` under their owning domain; keep shared error collection in `tests/support/browser-errors.ts`. See `tests/README.md` for taxonomy and size guidance. Add a focused config/support module only when it owns a coherent contract; avoid compatibility aliases and root-level spec files.
