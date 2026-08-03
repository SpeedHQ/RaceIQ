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
- [ ] Complete Sessions workflow coverage across supported games, including filters, recorded/inspected state, navigation, delete/export actions, and empty/error states.
- [ ] Complete Analyse workflow coverage across supported games, including lap selection, playback/cursor changes, charts, panels, imports, AI state, and telemetry capability differences.
- [ ] Complete Compare workflow coverage across supported games, including distinct seeded traces, synchronized controls, segment identity, AI state, responsive layout, and failure recovery.
- [ ] Complete Driver workflow coverage for supported games, including no-data and populated states, period filters, charts, metrics, and navigation.
- [ ] Complete Experiments workflow coverage for supported games, including create/import, version graph, test laps, live test dashboard, review, undo/delete, and unsupported-game routing.
- [ ] Complete Chats workflow coverage, including conversation selection, new/delete flows, empty/error states, prompt submission, streamed response behavior, and unsupported AI configuration.
- [ ] Complete Tracks and Cars coverage across every supported game, including search/filter/detail navigation, track geometry, car data, setup links, empty states, and unsupported routes.
- [ ] Complete Setups browser coverage. First fix: `playwright/seeded-setups.spec.ts` currently leaves `SearchSelect` open after choosing an option, so `not.toHaveValue("")` fails. Scope option locators to selected listbox or drive selection with keyboard, then verify F1 2025 and ACC filters, pagination, import, and unsupported CRUD controls.
- [ ] Complete Dash workflow coverage, including catalogue loading/no-data/error states, both combo routes, dashboard selection, persisted layout, responsive fit, and telemetry changes.
- [ ] Complete developer tools coverage, including recording list/viewer, AC Evo raw parsed/fields/verify/hex tabs, replay scrubber, disconnect isolation, invalid/empty recording responses, and dump import cleanup.
- [ ] Complete device and CI coverage: run mobile/tablet/desktop projects, confirm screenshot registry counts, validate workflow project selection and artifact upload, and remove redundant matrix work.
- [ ] Verify packaged application parity by running fresh-install/tunes projects against compiled binary, not only `E2E_SERVER_MODE=dev`.
- [ ] Run focused verification after each repair, then canonical checks: `bun run test`, Playwright seeded projects, fresh-install, tunes, responsive/device projects, and relevant snapshot tests. Confirm dynamic-over-lap fields change; document event/state-driven and fixture-limited constants with source evidence.
- [ ] Update `docs/contributing/e2e-testing.md` coverage matrix and `CHANGELOG.md` only after results are final; record remaining unsupported routes, fixtures, and justified telemetry constants.

## Resume notes
- Run Playwright commands from `playwright/` with `E2E_SERVER_MODE=dev` and `PW_SERVER_SET=seeded` for seeded coverage.
- Use `--max-failures=1 --reporter=line` during repair loops; raise project action timeout only through existing Playwright config.
- Last active repair: `playwright/seeded-setups.spec.ts`, helper `assertPaginationAndFilters`.
- Local runtime directories (`playwright/test-data-seeded/`, `.data-recording-support/`, `.data-telemetry-audit/`) are reproducible and should stay uncommitted.

## Open questions
- Which committed replay fixture should supply seeded sector-best data for estimated-lap assertions, or should those fields remain explicitly fixture-limited?
- Which packaged executable should CI use for parity on each target OS?
