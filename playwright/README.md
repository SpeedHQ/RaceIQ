# RaceIQ Playwright suite

This suite owns route-level browser tests and screenshot evidence. It is separate from `client/playwright.config.ts`, which runs Storybook snapshot tests against isolated client components. Run this suite from `playwright/` so package scripts, relative server commands, and generated paths keep their expected working directory.

## Projects

| Project | Match | Server/data |
| --- | --- | --- |
| `fresh-install` | `fresh-install/**/*.spec.ts` | Fresh compiled or dev app |
| `tunes` | `tunes/**/*.spec.ts` | Tunes app |
| `seeded-e2e` | `seeded/**/*.spec.ts` | Seeded app |
| `lap-replay` | `packages/lap-replay/test/e2e/**/*.spec.ts`, excluding native GPU specs | Seeded app |
| `lap-replay-webgpu` | Package-owned native Spectate camera and transition specs | Seeded app with a WebGPU adapter (hardware or software) |
| `record-demo` | `recording/demo.spec.ts` | Seeded replay with GPU launch flags |

`record-demo` waits for the seeded route/import suites and all feature projects to finish before frame capture because they share seeded server state.

From the repository root, `bun run record:demo` builds the app and selects this suite's configuration and seeded server. For a short capture after building, run `E2E_SERVER_MODE=compiled PW_SERVER_SET=seeded DEMO_MAX_FRAMES=3 bunx playwright test --config=playwright/playwright.config.ts --project=seeded-setup --project=record-demo --no-deps --workers=1` from the root. This runs migration setup before capture without the ordinary seeded suites; the one-worker limit preserves their order.

Marketing screenshot captures use `marketing-screenshots.config.ts`; responsive captures use `responsive-screenshots.config.ts`. Both live outside E2E projects. PR CI runs responsive captures only for base-vs-PR visual comparison.

The main config uses `tests/` as `testDir`; no E2E specs belong at `tests/` root. Screenshot capture uses dedicated configs. Stateful E2E projects stay ordered on one worker.

The `lap-replay-webgpu` project requires a WebGPU adapter and fails rather than skips if one is unavailable. Software adapters are allowed, so a passing run does not guarantee hardware coverage. Each test attaches adapter metadata, including `isFallbackAdapter`, to its results. It selects ANGLE Metal on macOS. On Windows it uses ANGLE D3D11 and the full Chromium channel, which bundles the DXIL shader libraries missing from the headless-shell distribution. Zoom-reversal checks synchronize with rendered mid-snap frames so browser-driver latency cannot move the input beyond the transition. CPU-compatible Spectate camera and full-range zoom scenarios remain in the cross-platform `lap-replay` project.

Root `test:e2e` (including `test:e2e:compiled`), its `fresh`/`tunes`/`seeded` variants, and root `screenshots` use `scripts/run-browser-verification.ts`: this cross-platform runner builds the production app with both F1 experiments and iRacing adapter flags, then starts compiled-server verification. `build:browser` exposes the feature-enabled build alone; ordinary `build` and release builds retain default feature settings. `ui:diff` builds both compared revisions with those flags before compiled responsive captures; `ui:diff:storybook` remains Storybook-only. The general `bun run test` sequence also performs a feature-enabled browser build immediately before Playwright E2E.

## Commands and server modes

```sh
cd playwright
bun install
bun run typecheck
bun run build
bun run test                         # build, then full Playwright run
bunx playwright test --project=seeded-e2e
E2E_SERVER_MODE=dev PW_SERVER_SET=fresh bunx playwright test --project=fresh-install # direct dev-mode diagnostic only
```

`E2E_SERVER_MODE` is `compiled` by default and accepts `dev` or `compiled`; canonical verification commands use compiled production binaries. Compiled mode launches `dist/raceiq` (`raceiq.exe` on Windows); build first. Dev mode launches Bun server and Vite client and is for deliberate developer diagnostics, not canonical visual verification. `PW_SERVER_SET` accepts `all`, `fresh`, `tunes`, or `seeded` and limits web-server instances. `PW_SCREENSHOT_ONLY=1` omits tunes server; pair with `PW_SEED_SCREENSHOTS=1` for read-only parallel screenshot capture. Port and data overrides are `PW_FRESH_INSTALL_*`, `PW_TUNES_*`, and `PW_SEEDED_E2E_*` (`PORT`, `CLIENT_PORT`, `UDP_PORT`, `DATA_DIR`). `RACEIQ_APP_ROOT` overrides repository root for dev launcher subprocesses. `CI` controls retry/reporter defaults; `PW_SCREENSHOT_WORKERS` controls screenshot worker count.

Generate marketing images in `assets/screenshots/` with `E2E_SERVER_MODE=dev PW_SERVER_SET=seeded PW_SCREENSHOT_ONLY=1 PW_SEED_SCREENSHOTS=1 bun run screenshots` from `playwright/`. To refresh Home only, append `--grep 'screenshot: home$'`. The Home capture waits for dashboard metadata and loading panels to finish; it fails instead of saving a loading or error state. This screenshot-capture runner is separate from E2E projects. The root-level `bun run screenshots` command generates responsive evidence, not these marketing assets.
Storybook screenshot tests create missing baselines on first run and compare them on later runs.

Launchers and screenshot database seeding live together in `support/server/`. They resolve repository root from their deeper location before starting application processes.

Seed scripts decode checked-in source fixtures and store sparse captures before seeded E2E servers start. Legacy full-frame recordings are rejected by `POST /api/laps/import`; disposable import tests use sparse captures exported from the seeded database.
Fresh-install wizard attempts reset both `settings.json` and the isolated database's dashboard access state, including login sessions and the configured-access marker. Resetting settings alone does not restore the pending password choice after a completed attempt. The persisted-settings assertion uses the fixture's explicit IPv4 loopback listener instead of relying on `localhost` address selection.

Specs that validate analyst output import the pure schema from `@raceiq/backend-core/ai/output-schema`. The server's `ai/schemas` module also owns setup-catalog validation and must not be loaded by the Node-based Playwright discovery process.


Recording-location migration coverage lives in `tests/fresh-install/recording-location-migration.spec.ts`. It converts a real capture in an isolated offline database with `bun run apps/backend/scripts/data/seed-db.ts --games=fm-2023 --fixtures=test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz --legacy-recordings`, imports the sparse capture through the running app's API, then prepares the returned sessions in the legacy folder layout. The test verifies initial file/session counts, required consent, byte-preserving organization under `<game>/own` in a selected folder, preservation of unrelated destination files, source removal, and persisted recording-directory settings. It deletes imported sessions, restores settings, and removes disposable files and folders afterward.

```sh
E2E_SERVER_MODE=dev PW_SERVER_SET=fresh bunx playwright test tests/fresh-install/recording-location-migration.spec.ts --project=fresh-install --workers=1
```

## Release-tag to main upgrade smoke

`bun run test:upgrade` runs the release-to-main smoke in an Ubuntu Playwright container with a twenty-minute test ceiling. It checks out the latest published stable release, installs its dependencies, and replays its default fixtures into a disposable preparation database. The fixture builder converts sparse sessions to per-lap storage, then verifies every seeded session has a matching manifest, lap bindings, and strictly decodable files. Only then does the harness seed the base installation with the prepared database. The base app never starts with unsplit data. The test then checks out the fetched `origin/main`, reinstalls dependencies, and starts it against the same base data. The caller's working tree and application data are never switched, reset, or mounted.

The released checkout uses the exact Bun version declared in its `packageManager` field for its frozen install, seed, and application processes. The main checkout uses the launcher image's Bun version.

Docker and Bun are required on the launcher host. `RACEIQ_UPGRADE_PREVIOUS_TAG` optionally pins the baseline; otherwise GitHub's latest published stable release is used. The base must support per-lap split fixtures (`v0.22.0` is the tested baseline). `RACEIQ_UPGRADE_REPOSITORY` optionally supplies an HTTPS clone URL; otherwise the current repository's origin is used, with GitHub SSH origins normalized to HTTPS. `GH_REPO` selects release metadata. `GH_TOKEN` or `GITHUB_TOKEN` authenticates GitHub; the launcher can reuse the host's `gh auth token` without mounting host credentials. Only diagnostics are bind-mounted out, to `RACEIQ_UPGRADE_ARTIFACTS_DIR` (default `playwright/test-results/source-upgrade`).

The running container is named `raceiq-upgrade-smoke-<launcher-pid>` (printed by the launcher). Use `docker logs -f <container-name>` to follow the resolved release and main SHAs, fixture preparation, seed installation, browser-driven setup and organization, and preservation checks. The launcher also saves `docker-run.log` and timestamped source logs in the artifact directory. The container is removed when the run exits.

Run `bun run test:upgrade --replay` to retain trace and video recordings even when the test passes, then open the recordings in the local Playwright Trace Viewer after Docker exits. The viewer serves on loopback and opens your default browser; inspect screenshots, DOM snapshots, actions, network traffic, and logs step by step. Press Ctrl+C when finished. Failed tests also open their available recordings and retain their failing exit status after the viewer closes. If the run produces no trace, the launcher reports that instead of opening an earlier run's recording. Other arguments still pass through to Playwright. Local dependencies must be installed (`bun install`) for the viewer; no host browser download is required.

The image includes only the smoke harness, never host dependencies, fixtures, or secrets. Seed inputs and the split implementation come from the released checkout. The smoke verifies zero pending recording splits on both versions, completes applicable setup and recording organization dialogs through the browser, and waits for startup reconciliation on main. It verifies that session IDs for FM2023, F1 2025, ACC, AC Evo, iRacing, LMU, and AMS2 survive the transition.

Seed replay has a ten-minute deadline; split publication and validation have five minutes. Missing fixtures, failed jobs, unreadable chunks, or incomplete lap bindings fail preparation before the base database is installed. The runtime seed keeps the canonical recordings retained by RaceIQ alongside the published splits.

CI runs this test only in the release workflow, in a dedicated Ubuntu job. Draft-release creation requires its success even when the broad Playwright suite is skipped. Source-server logs, ref metadata, and browser evidence are uploaded on failure. This proves the specified source-checkout transition in Ubuntu Docker, not operating-system installer behavior.


## Known seeded coverage gaps

Confirmed unresolved coverage gaps live in [Test Coverage Gaps](../docs/project-status/test-gaps.md), including AC Evo valid-session telemetry reuse. The seeded AC Evo invalid-session check remains active; no case is skipped for that fixture limitation.

Track catalog checks cover the Debug tab in dev mode and assert its absence in compiled production mode. Cleanup fixtures inspect captures under `<game>/own`; setup deletion teardown removes the setup before deleting its disposable sessions and their laps.

## Data safety and generated output

Launchers create configured E2E data directories and delete only their SQLite database files at startup. They preserve non-database fixture files and do not perform teardown cleanup. Seeded tests share one isolated server per shard; tests that mutate notes, imports, sessions, or settings must restore their own state. CI containers are disposable.

Compiled E2E CI prepares seeded data once in a prerequisite job. Before upload, it checks SQLite integrity and foreign keys, replayable lap coverage for every configured seeded game, capture availability, and telemetry readability, then checkpoints the WAL. The artifact contains `app.db`, chat memory, and generated `sessions/` captures; database capture references are portable paths rather than producer-specific absolute paths.

Linux compiled E2E jobs reuse the upstream Linux `raceiq-dist` artifact instead of rebuilding the client and server in every shard. Other platforms build their own binary; callers without an artifact still build locally. CI runs Bun with `BUN_OPTIONS=--smol` so replay allocations are collected sooner within the runner's memory budget.

Seeded shards download that artifact and set `PW_SEEDED_DATABASE` to its database path, resolved relative to the repository root. Both launchers reset their private database, copy the artifact's database and referenced captures into the shard data directory, rebase capture paths, and skip fixture imports. `bun run test` prepares one local snapshot and reuses it for both seeded server sets; standalone local Playwright runs without this override still seed normally. Import and conversion tests continue exercising real imports. Generated `playwright/test-data-*` directories are ignored by Git.

Capture restoration includes manifest-referenced chunks, opponent companions, and capture archives. Session and live-capture database references are rebased to each shard's private directory. Source assets and destination directories must remain inside their respective roots after symlink resolution. The local all-tests runner creates a unique temporary seed producer directory and removes it after the suites finish.

Playwright output goes to `playwright/test-results/`. Responsive captures go to `playwright/screenshots/` (mobile captures under `screenshots/mobile/`). Both are generated artifacts and must not be committed. Seeded data under `test-results/` is disposable.

## Responsive visual baselines

Pull-request screenshot CI renders every responsive screenshot case twice in the same runner environment: once from the PR and once from its current base revision. Both renders use compiled production apps built with both F1 experiments and iRacing adapter flags enabled. Each shard builds its revision before rendering; the base render uses the PR's screenshot spec so renamed selectors do not break baseline capture. The base render is the visual baseline. Screenshot-only menu cases use keyboard activation so overlapping controls in the base revision do not prevent capturing visual differences. Pixel differences at or below the shared 1% tolerance are treated as rendering noise; added, removed, resized, or materially changed screenshots fail the `screenshots` check.

Dashboard render CI uses four shards (`--shard=1/4` through `--shard=4/4`) for both revisions. Each shard captures 23 of the 92 screenshots; the collector merges all four artifacts before comparison.

Failed comparisons still upload the `pr-screenshot-preview` artifact and publish before/after/diff images in the PR UI-change comment. Review those images before accepting a visual change.

To update the baseline intentionally:

1. Run `bun run ui:diff` locally and inspect `.ui-diff/report.html`.
2. Push the UI change and confirm the PR preview artifact/comment shows only intended differences.
3. Merge the reviewed PR. Its renders become the base revision for later PRs; responsive PNGs remain generated artifacts and are not committed.

## Adding coverage

Add a spec under its domain in `tests/` and update the matching project only when its path or server needs differ from existing definitions. Keep project names, test titles, assertions, serial/stateful behavior, cleanup, and generated locations stable when moving coverage. Put reusable browser assertions/data in `tests/support/` under their owning domain; keep shared error collection in `tests/support/browser-errors.ts`. See `tests/README.md` for taxonomy and size guidance. Add a focused config/support module only when it owns a coherent contract; avoid compatibility aliases and root-level spec files.
