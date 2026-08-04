# Plan

Finish RaceIQ E2E coverage audit and stabilize new seeded Playwright coverage before declaring page/game coverage acceptable. Resume from committed source and regenerate local seeded data; do not rely on `playwright/test-data-seeded/` runtime output.

## Scope
- In: Remaining page workflows, supported-game matrices, lap telemetry behavior, responsive/CI coverage, packaged-app parity, final verification, audit docs, release notes.
- Out: New product features unrelated to E2E coverage.

## Completed
- [x] Home and Settings interaction coverage.
- [x] Game landing state coverage.
- [x] Live dashboard transition and replay-driven value coverage.
- [x] Raw telemetry presentation, category, provenance, and unsupported-value coverage.

## Action items
- [x] Complete Sessions workflow coverage across supported games, including filters, recorded/inspected state, navigation, delete/export actions, and empty/error states.
- [x] Complete Analyse workflow coverage across supported games, including lap selection, playback/cursor changes, charts, panels, imports, AI state, and telemetry capability differences.
- [x] Complete Compare workflow coverage across supported games, including distinct seeded traces, synchronized controls, segment identity, AI state, responsive layout, and failure recovery.
- [x] Complete Driver workflow coverage for supported games, including no-data and populated states, period filters, charts, metrics, and navigation.
- [x] Complete Experiments workflow coverage for supported games, including create/import, version graph, test laps, live test dashboard, review, undo/delete, and unsupported-game routing.
- [x] Complete Chats workflow coverage, including conversation selection, new/delete flows, empty/error states, prompt submission, streamed response behavior, and unsupported AI configuration.
- [x] Complete Tracks and Cars coverage across every supported game, including search/filter/detail navigation, track geometry, car data, setup links, empty states, and unsupported routes.
- [x] Complete Setups browser coverage with listbox-scoped `SearchSelect` option handling, F1 2025 and ACC filters, pagination, import, and honest unsupported CRUD controls.
- [x] Complete Dash workflow coverage, including catalogue loading/no-data/error states, both combo routes, dashboard selection, persisted layout, responsive fit, and telemetry changes.
- [x] Complete developer tools coverage, including recording list/viewer, AC Evo raw parsed/fields/verify/hex tabs, replay scrubber, disconnect isolation, invalid/empty recording responses, and dump import cleanup.
- [x] Complete device and CI coverage: run mobile/tablet/desktop projects, confirm screenshot registry counts, validate workflow project selection and artifact upload, and remove redundant matrix work.
- [x] Verify packaged application parity by running fresh-install/tunes projects against compiled binary, not only `E2E_SERVER_MODE=dev`.
- [x] Run focused verification after each repair, then canonical checks: `bun run test`, Playwright seeded projects, fresh-install, tunes, responsive/device projects, and relevant snapshot tests. Confirm dynamic-over-lap fields change; document event/state-driven and fixture-limited constants with source evidence.
- [x] Update `docs/contributing/e2e-testing.md` coverage matrix and `CHANGELOG.md` only after results are final; record remaining unsupported routes, fixtures, and justified telemetry constants.

## Resume notes
- Run Playwright commands from `playwright/` with `E2E_SERVER_MODE=dev` and `PW_SERVER_SET=seeded` for seeded coverage.
- Use `--max-failures=1 --reporter=line` during repair loops; raise project action timeout only through existing Playwright config.
- Final canonical results and fixture limits are recorded in `docs/contributing/e2e-testing.md`.
- Local runtime directories (`playwright/test-data-seeded/`, `.data-recording-support/`, `.data-telemetry-audit/`) are reproducible and should stay uncommitted.

## Decisions
- Keep sector-best and estimated-lap fields explicitly fixture-limited until a committed replay provides completed sector history.
- Use `dist/raceiq.exe` for Windows packaged parity and `dist/raceiq` on other targets.
