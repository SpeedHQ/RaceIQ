# RaceIQ Playwright suite

This suite owns route-level browser tests and screenshot evidence. It is separate from `client/playwright.config.ts`, which runs Storybook snapshot tests against isolated client components. Run this suite from `playwright/` so package scripts, relative server commands, and generated paths keep their expected working directory.

## Projects

| Project | Match | Server/data |
| --- | --- | --- |
| `fresh-install` | `fresh-install/**/*.spec.ts`, `responsive/workspaces.spec.ts` | Fresh compiled or dev app |
| `marketing` | `marketing/**/*.spec.ts` | `MARKETING_BASE_URL` (default `https://raceiq.localhost`) |
| `app-screenshots` | `responsive/desktop-screenshots.spec.ts`, `responsive/lmu-screenshots.spec.ts`, `responsive/mobile-dashboard-screenshots.spec.ts` | Seeded app |
| `tunes` | `tunes/**/*.spec.ts` | Tunes app |
| `mobile-device`, `tablet-device` | `responsive/device.spec.ts` | Seeded app with Chromium device emulation |
| `seeded-e2e` | `seeded/**/*.spec.ts` | Seeded app |
| `record-demo` | `recording/demo.spec.ts` | Fresh app with GPU launch flags |

Config uses `tests/` as `testDir`; no specs belong at `tests/` root. Stateful projects stay ordered on one worker. Only seeded screenshot runs enable parallel screenshot workers.

Root `test:e2e` (including `test:e2e:compiled`) and workspace `test`/`test:ui` force `--workers=1`, overriding `PW_WORKERS`. Root `test:e2e:all` inherits the workspace limit. Capture migration and ordinary seeded projects share one database; per-project worker limits do not prevent cross-project overlap. Keep direct multi-project invocations containing capture migration on `--workers=1`.

## Commands and server modes

```sh
cd playwright
bun install
bun run typecheck
bun run build
bun run test                         # build, then full Playwright run
bunx playwright test --project=seeded-e2e
E2E_SERVER_MODE=dev PW_SERVER_SET=seeded PW_SCREENSHOT_ONLY=1 bunx playwright test --project=app-screenshots
E2E_SERVER_MODE=dev bunx playwright test --project=seeded-e2e
PW_SERVER_SET=fresh bunx playwright test --project=fresh-install
```

`E2E_SERVER_MODE` is `compiled` by default and accepts `dev` or `compiled`. Compiled mode launches `dist/raceiq` (`raceiq.exe` on Windows); build first. Dev mode launches Bun server and Vite client. `PW_SERVER_SET` accepts `all`, `fresh`, `tunes`, or `seeded` and limits web-server instances. `PW_SCREENSHOT_ONLY=1` omits tunes server; pair with `PW_SEED_SCREENSHOTS=1` for read-only parallel screenshot capture. Port and data overrides are `PW_FRESH_INSTALL_*`, `PW_TUNES_*`, and `PW_SEEDED_E2E_*` (`PORT`, `CLIENT_PORT`, `UDP_PORT`, `DATA_DIR`). `RACEIQ_APP_ROOT` overrides repository root for dev launcher subprocesses. `CI` controls retry/reporter defaults; `PW_SCREENSHOT_WORKERS` controls screenshot worker count.
Storybook screenshot tests create missing baselines on first run and compare them on later runs.

Launchers and screenshot database seeding live together in `support/server/`. They resolve repository root from their deeper location before starting application processes.

Migration E2E imports all six complete game fixtures first via `POST /api/laps/import` with multipart `file`, `ownership=mine`, and `captureStorage=raw`. This stores full canonical records without direct database/file seeding. The test then opens the mandatory conversion dialog, presses Convert, and verifies replay before/after. Omit `captureStorage` for ordinary UI imports; those continue using sparse storage immediately. Raw storage is supported only for `.bin` and `.bin.gz` uploads, including native iRacing and LMU dumps.

## Known seeded coverage gaps

Confirmed unresolved coverage gaps live in [Test Coverage Gaps](../docs/project-status/test-gaps.md), including AC Evo valid-session telemetry reuse. The seeded AC Evo invalid-session check remains active; no case is skipped for that fixture limitation.

## Data safety and generated output

Launchers create configured E2E data directories and delete only their SQLite database files at startup. They preserve non-database fixture files and do not perform teardown cleanup. Seeded tests share one isolated server per shard; tests that mutate notes, imports, sessions, or settings must restore their own state. CI containers are disposable.

Compiled E2E CI prepares seeded data once in a prerequisite job. Before upload, it checks SQLite integrity and foreign keys, replayable lap coverage for all five seeded games, capture availability, and telemetry readability, then checkpoints the WAL. The artifact contains `app.db` and generated `sessions/` captures; database capture references are portable paths rather than producer-specific absolute paths.

Seeded shards download that artifact and set `PW_SEEDED_DATABASE` to its database path, resolved relative to the repository root. Both launchers reset their private database, copy the artifact's database and referenced captures into the shard data directory, rebase capture paths, and skip fixture imports. Fresh/tunes projects remain unchanged; local runs without this override still seed normally. Import and conversion tests continue exercising real imports. Generated `playwright/test-data-*` directories are ignored by Git.

Playwright output goes to `playwright/test-results/`. App captures go to `playwright/screenshots/app/`: desktop screens plus only the mobile live dashboard. No other phone or tablet screenshots. Both output trees are generated artifacts and must not be committed. Seeded data under `test-results/` is disposable; functional device-emulation tests remain.

## Responsive visual baselines

Pull-request screenshot CI renders every `app-screenshots` case twice in the same runner environment: once from the PR and once from its current base revision. Both renders use the PR's screenshot specs, registry, project configuration, and setup seeds. The base render is the visual baseline. Screenshot-only menu cases use keyboard activation so overlapping controls in the base revision do not prevent capturing visual differences. Pixel differences at or below the shared 1% tolerance are treated as rendering noise.

Failed comparisons still upload the `pr-screenshot-preview` artifact and publish before/after/diff images in the PR UI-change comment. Review those images before accepting a visual change.

To update the baseline intentionally:

1. Run `bun run ui:diff` locally and inspect `.ui-diff/report.html`.
2. Push the UI change and confirm the PR preview artifact/comment shows only intended differences.
3. Merge the reviewed PR. Its renders become the base revision for later PRs; responsive PNGs remain generated artifacts and are not committed.

## Adding coverage

Add a spec under its domain in `tests/` and update the matching project only when its path or server needs differ from existing definitions. Keep project names, test titles, assertions, serial/stateful behavior, cleanup, and generated locations stable when moving coverage. Put reusable browser assertions/data in `tests/support/` under their owning domain; keep shared error collection in `tests/support/browser-errors.ts`. See `tests/README.md` for taxonomy and size guidance. Add a focused config/support module only when it owns a coherent contract; avoid compatibility aliases and root-level spec files.
