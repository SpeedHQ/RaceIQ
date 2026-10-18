# RaceIQ Playwright suite

This suite owns route-level browser tests and screenshot evidence. It is separate from `client/playwright.config.ts`, which runs Storybook snapshot tests against isolated client components. Run this suite from `playwright/` so package scripts, relative server commands, and generated paths keep their expected working directory.

## Projects

| Project | Match | Server/data |
| --- | --- | --- |
| `fresh-install` | `fresh-install/**/*.spec.ts` | Fresh compiled or dev app |
| `tunes` | `tunes/**/*.spec.ts` | Tunes app |
| `seeded-e2e` | `seeded/**/*.spec.ts` | Seeded app |
| `record-demo` | `recording/demo.spec.ts` | Fresh app with GPU launch flags |
Marketing screenshot captures use `marketing-screenshots.config.ts`; responsive captures use `responsive-screenshots.config.ts`. Both live outside E2E projects. PR CI runs responsive captures only for base-vs-PR visual comparison.

The main config uses `tests/` as `testDir`; no E2E specs belong at `tests/` root. Screenshot capture uses dedicated configs. Stateful E2E projects stay ordered on one worker.

Root `test:e2e` (including `test:e2e:compiled`) and workspace `test`/`test:ui` force `--workers=1`, overriding `PW_WORKERS`. Root `test:e2e:all` inherits the workspace limit. Capture migration and ordinary seeded projects share one database; per-project worker limits do not prevent cross-project overlap. Keep direct multi-project invocations containing capture migration on `--workers=1`.

## Commands and server modes

```sh
cd playwright
bun install
bun run typecheck
bun run build
bun run test                         # build, then full Playwright run
bunx playwright test --project=seeded-e2e
PW_SERVER_SET=seeded PW_SCREENSHOT_ONLY=1 PW_SEED_SCREENSHOTS=1 bun run screenshots:mobile # standalone capture
E2E_SERVER_MODE=dev bunx playwright test --project=seeded-e2e
PW_SERVER_SET=fresh bunx playwright test --project=fresh-install
```

`E2E_SERVER_MODE` is `compiled` by default and accepts `dev` or `compiled`. Compiled mode launches `dist/raceiq` (`raceiq.exe` on Windows); build first. Dev mode launches Bun server and Vite client. `PW_SERVER_SET` accepts `all`, `fresh`, `tunes`, or `seeded` and limits web-server instances. `PW_SCREENSHOT_ONLY=1` omits tunes server; pair with `PW_SEED_SCREENSHOTS=1` for read-only parallel screenshot capture. Port and data overrides are `PW_FRESH_INSTALL_*`, `PW_TUNES_*`, and `PW_SEEDED_E2E_*` (`PORT`, `CLIENT_PORT`, `UDP_PORT`, `DATA_DIR`). `RACEIQ_APP_ROOT` overrides repository root for dev launcher subprocesses. `CI` controls retry/reporter defaults; `PW_SCREENSHOT_WORKERS` controls screenshot worker count.

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

`bun run test:upgrade` builds an Ubuntu Playwright image and runs one smoke scenario inside Docker, with a twenty-minute test ceiling. It checks out the last published stable release tag, installs dependencies, and runs that version's `db:seed` with its default all-game fixtures: FM2023, F1 2025, ACC, AC Evo, iRacing, and LMU. Seeding has a ten-minute deadline; capture conversion and recording organization each allow up to five minutes for the full dataset. Playwright starts the released dev app and completes outstanding onboarding and capture-conversion dialogs before updating. It then checks out freshly fetched `origin/main`, reinstalls dependencies, and starts the new code against the same user-data directory. The caller's working tree and application data are never switched, reset, or mounted.

Docker and Bun are required on the launcher host. `RACEIQ_UPGRADE_PREVIOUS_TAG` optionally pins the baseline; otherwise GitHub's latest published release is used. `RACEIQ_UPGRADE_REPOSITORY` optionally supplies an HTTPS clone URL; otherwise the current repository's origin is used, with GitHub SSH origins normalized to HTTPS. `GH_REPO` selects release metadata. `GH_TOKEN` or `GITHUB_TOKEN` authenticates GitHub; the launcher can reuse the host's `gh auth token` without mounting host credentials. Only diagnostics are bind-mounted out, to `RACEIQ_UPGRADE_ARTIFACTS_DIR` (default `playwright/test-results/source-upgrade`).

The running container is named `raceiq-upgrade-smoke-<launcher-pid>` (printed by the launcher). Open its **Logs** tab in OrbStack, or use `docker logs -f <container-name>`, to follow checkout commands, resolved release/main SHAs, dependency installation, seed/database migrations, backend/client output, and `START`/`DONE` markers for browser-driven setup, conversion, organization, and data-preservation checks. Output is also saved in `docker-run.log` and timestamped source logs in the artifact directory. The container is removed when the run exits; use those files for completed-run diagnostics.

Run `bun run test:upgrade --replay` to retain trace and video recordings even when the test passes, then open the recordings in the local Playwright Trace Viewer after Docker exits. The viewer serves on loopback and opens your default browser; inspect screenshots, DOM snapshots, actions, network traffic, and logs step by step. Press Ctrl+C when finished. Failed tests also open their available recordings and retain their failing exit status after the viewer closes. If the run produces no trace, the launcher reports that instead of opening an earlier run's recording. Other arguments still pass through to Playwright. Local dependencies must be installed (`bun install`) for the viewer; no host browser download is required.

Both resolved commit IDs are recorded before the transition. The image includes only the smoke harness, never host dependencies, fixtures, or secrets; seed inputs come from the released checkout. Playwright requires pending dialogs, presses their real controls, waits for success, closes them, and reaches the usable application. The smoke also waits for the main startup worker to finish reconciliation before declaring success; a failed stage fails the smoke instead of being hidden by successful database and recording-layout migrations. Each of the six games must have seeded sessions before updating, and its session IDs must survive so missing game fixtures or an accidental database reset cannot pass. It does not compare lap timing, telemetry, or capture bytes; those remain separate regression tests. No offline capture conversion, manual database repair, or reset is allowed between refs.

Before switching refs, the smoke stops the released servers and reads the released database in read-only mode. Every recording must exist, have `capture_format_version = 1`, and pass the released strict frame decoder. Logs identify game, session, file, and whether the converted output contains deltas, a format marker, or only checkpoints. Released checkpoint-only output is valid with version-1 provenance; no recording is rewritten or decorated with a marker by the test.

CI runs this test only in the release workflow, in a dedicated Ubuntu job. Draft-release creation requires its success even when the broad Playwright suite is skipped. Source-server logs, ref metadata, and browser evidence are uploaded on failure. This proves the specified source-checkout transition in Ubuntu Docker, not operating-system installer behavior.


## Known seeded coverage gaps

Confirmed unresolved coverage gaps live in [Test Coverage Gaps](../docs/project-status/test-gaps.md), including AC Evo valid-session telemetry reuse. The seeded AC Evo invalid-session check remains active; no case is skipped for that fixture limitation.

Track catalog checks cover the Debug tab in dev mode and assert its absence in compiled production mode. Cleanup fixtures inspect captures under `<game>/own`; setup deletion teardown removes the setup before deleting its disposable sessions and their laps.

## Data safety and generated output

Launchers create configured E2E data directories and delete only their SQLite database files at startup. They preserve non-database fixture files and do not perform teardown cleanup. Seeded tests share one isolated server per shard; tests that mutate notes, imports, sessions, or settings must restore their own state. CI containers are disposable.

Compiled E2E CI prepares seeded data once in a prerequisite job. Before upload, it checks SQLite integrity and foreign keys, replayable lap coverage for all five seeded games, capture availability, and telemetry readability, then checkpoints the WAL. The artifact contains `app.db` and generated `sessions/` captures; database capture references are portable paths rather than producer-specific absolute paths.

Linux compiled E2E jobs reuse the upstream Linux `raceiq-dist` artifact instead of rebuilding the client and server in every shard. Other platforms build their own binary; callers without an artifact still build locally. CI runs Bun with `BUN_OPTIONS=--smol` so replay allocations are collected sooner within the runner's memory budget.

Seeded shards download that artifact and set `PW_SEEDED_DATABASE` to its database path, resolved relative to the repository root. Both launchers reset their private database, copy the artifact's database and referenced captures into the shard data directory, rebase capture paths, and skip fixture imports. `bun run test` prepares one local snapshot and reuses it for both seeded server sets; standalone local Playwright runs without this override still seed normally. Import and conversion tests continue exercising real imports. Generated `playwright/test-data-*` directories are ignored by Git.

Playwright output goes to `playwright/test-results/`. Responsive captures go to `playwright/screenshots/` (mobile captures under `screenshots/mobile/`). Both are generated artifacts and must not be committed. Seeded data under `test-results/` is disposable.

## Responsive visual baselines

Pull-request screenshot CI renders every responsive screenshot case twice in the same runner environment: once from the PR and once from its current base revision. Both renders use dev mode (Bun backend and Vite client), so no compiled artifact download or base production build is needed. Both renders use the PR's screenshot spec so renamed selectors do not break baseline capture. The base render is the visual baseline. Screenshot-only menu cases use keyboard activation so overlapping controls in the base revision do not prevent capturing visual differences. Pixel differences at or below the shared 1% tolerance are treated as rendering noise; added, removed, resized, or materially changed screenshots fail the `screenshots` check.

Dashboard render CI uses four shards (`--shard=1/4` through `--shard=4/4`) for both revisions. Each shard captures 23 of the 92 screenshots; the collector merges all four artifacts before comparison.

Failed comparisons still upload the `pr-screenshot-preview` artifact and publish before/after/diff images in the PR UI-change comment. Review those images before accepting a visual change.

To update the baseline intentionally:

1. Run `bun run ui:diff` locally and inspect `.ui-diff/report.html`.
2. Push the UI change and confirm the PR preview artifact/comment shows only intended differences.
3. Merge the reviewed PR. Its renders become the base revision for later PRs; responsive PNGs remain generated artifacts and are not committed.

## Adding coverage

Add a spec under its domain in `tests/` and update the matching project only when its path or server needs differ from existing definitions. Keep project names, test titles, assertions, serial/stateful behavior, cleanup, and generated locations stable when moving coverage. Put reusable browser assertions/data in `tests/support/` under their owning domain; keep shared error collection in `tests/support/browser-errors.ts`. See `tests/README.md` for taxonomy and size guidance. Add a focused config/support module only when it owns a coherent contract; avoid compatibility aliases and root-level spec files.
