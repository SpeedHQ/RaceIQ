# End-to-end testing

This page is source of truth for RaceIQ browser audits. It separates semantic checks from visual evidence and records what still needs a real seeded run. A green screenshot is not proof that telemetry semantics, route data, or unsupported values are correct.

## Status

**Audit result:** complete for committed fixtures and locally executable browser scope as of 2026-08-04. Canonical results: 2,726 unit tests passed with one documented corrupt-fixture skip; dev-server `seeded-e2e` passed 169 tests with three fixture-conditional skips; compiled `fresh-install` passed 34 tests; compiled `tunes` passed 7 tests; responsive screenshots passed all 97 registry cases; Chromium device projects passed both owned mobile/tablet cases; screenshot registry and telemetry catalog checks passed.

**Acceptance boundary:** local results prove committed replay/parser behavior, browser workflows, compiled Windows binary parity, responsive viewports, and Chromium device emulation. They do not prove GitHub-hosted CI execution, physical-device behavior, configured AI response quality, or telemetry transitions absent from committed recordings. Those limits remain explicit below rather than being counted as unsupported product behavior.

## Coverage model

Use four kinds of evidence. Do not substitute one for another:

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| Functional E2E | Route loads, controls work, API writes/reads, lap identity and field semantics | Pixel fidelity |
| Responsive screenshots | Layout, clipping, responsive breakpoints, visual state | Semantic correctness or data provenance |
| Storybook snapshots | Reusable component states and visual contracts in isolated renderer | Route integration, adapter/parser behavior, native telemetry |
| Native recordings/replay | Real adapter packet/frame parsing, lap boundaries, field availability | Browser layout or every route interaction |

Functional E2E and screenshots share reusable seams: seeded database, route-case matrix, stable `data-testid`/accessible labels, and deterministic playback clock. Keep assertions at seams rather than duplicating per-game page scripts.

### Route surfaces

Audit route families, not only home pages:

- Global: `/`, `/dash`, `/dash/combo-1`, `/dash/combo-2`, `/dev`.
- Shared game routes for each game id: `/:gameid`, `/:gameid/analyse`, `/:gameid/cars`, `/:gameid/chats`, `/:gameid/compare`, `/:gameid/driver`, `/:gameid/experiments`, `/:gameid/sessions`, `/:gameid/tracks`, `/:gameid/tracks/:trackOrdinal/info`, and each track detail tab.
- Game-specific surfaces: `/fm23/live`, `/fm23/raw`, `/fm23/setups` (catalog/new/edit/import and car ordinal); `/f125/raw`, `/f125/setups`, `/f125/tunes`; `/acc/raw`, `/acc/setups` (new/edit/import); `/ac-evo/raw`, `/ac-evo/setups` (new/edit/import); `/iracing/raw`, `/iracing/live` (driver/pit).
- Route reachability checks must include navigation into and back out of each family. A page that renders shell only is not functional coverage.

### Seeded game matrix

`playwright/seeded-e2e-cases.ts` is canonical. Every entry uses real seeded rows, not hand-written response mocks:

| Game | game id | track ordinal | track | Purpose |
| --- | --- | ---: | --- | --- |
| Forza Motorsport 2023 | `fm-2023` | 5 | Road America | shared routes, FM live/raw/setup paths |
| F1 2025 | `f1-2025` | 19 | Autodromo Hermanos Rodriguez | F1 live/raw/setup/tune paths |
| Assetto Corsa Competizione | `acc` | 2 | Brands Hatch | shared routes, ACC setup/raw/live paths |
| Assetto Corsa Evo | `ac-evo` | 2 | Brands Hatch | shared routes, AC Evo setup/raw paths |
| iRacing | `iracing` | 18 | Road America | shared routes, iRacing live/raw paths |

For each case, functional tests should open game home, sessions, tracks, track detail, cars, analyse, compare, driver, experiments, chats, raw telemetry, and applicable setup/live routes. Mark a route unsupported only when adapter capability says so; distinguish unavailable fixture data from unsupported product behavior.

### Functional coverage inventory

`seeded-routes.spec.ts` proves listed game routes render against real seeded state, fit workspace, and avoid route errors. Route health is not interaction coverage. Current browser contract and remaining behavior:

| Surface | Games | Automated now | Fixture or external limit |
| --- | --- | --- | --- |
| Onboarding, home, settings | all | Fresh-install wizard; game/sidebar/mobile navigation; period filters; recent-lap navigation; settings persistence, reset, language, units, connection, wheel, sound, storage, AI, developer, diagnostics, updates, and responsive overlays | Update installation and configured external AI providers remain environment-dependent |
| Game landing | all | Populated and empty cards, primary navigation, responsive layout, and route-state checks | None in committed scope |
| Live dashboard | all | Committed replay changes declared dynamic channels, preserves static labels, exercises driver/pit routes, and verifies disconnect/reconnect for every supported live adapter | Transition-only channels still require recordings containing those events |
| Sessions and recap | all | Recorded/Imported tabs, search, pagination, recap, notes, ZIP export, compare/analyse navigation, context validity action, delete cancel/success, loading/error/true-empty states, and cleanup-safe disposable imports | MoTeC import remains skipped because repository has no committed `.ld` fixture |
| Analyse | all | Lap/track/car selection, playback speeds and cursor/keyboard changes, charts, panels, layout, notes, CSV/bin import/export, AI state, telemetry capability differences, error states, and cleanup-safe actions | FM no-telemetry empty-lap case remains skipped because seed has no lap matching that condition |
| Compare | all | Distinct traces and deltas, synchronized cursor/controls, segment identity, layout/map controls, AI state, same-lap rejection, responsive fit, reload/cache behavior, and deterministic failure recovery | iRacing distinct-pair case remains skipped because committed seed lacks two comparable valid laps; incomplete-selection behavior is covered |
| Driver | FM, F1, ACC, AC Evo | Deterministic API/UI totals, period filters, charts, metrics, populated/no-data/error states, and lap navigation | Configured provider run/retry remains external |
| Experiments | F1, ACC, AC Evo | Create/focus/import, version graph, comparison, test laps, live dashboard, review, history, undo/archive/delete, cleanup recovery, and unsupported routing for FM/iRacing | None in committed scope |
| Chats | all | Conversation selection, new/delete flows, empty/loading/error states, prompt submission, streamed response handling, Analyse/Compare/Tune context, and unsupported AI configuration | Response quality with paid providers remains opt-in |
| Tracks and track detail | all | Search, sorting, map controls, detail/tab navigation, geometry/capability routes, sector/segment controls, lap actions, imports, guide/setup links, no-data/error states, and cleanup | Transition-rich lap evidence remains recording-dependent |
| Cars | all | Every game catalog, search/category filters, detail navigation, table/grid modes, compare controls, setup links, empty states, keyboard/accessible selection, and unsupported routes | External model/image availability is not semantic coverage |
| Setups/tunes | FM, F1, ACC, AC Evo | Source/author/track/car filters, pagination, create/edit/import/validation, clone/duplicate/delete/refresh, persisted state, F1 and ACC workflows, and honest unsupported CRUD controls | AC Evo native setup inspection depends on installed-game evidence and is asserted as unavailable when absent |
| Raw telemetry | all | Catalog metadata, populated/unsupported/static/event categories, provenance, replay-driven changes, and AC Evo parsed/fields/verify/hex inspection | Event fields stay fixture-limited when recording contains no transition |
| Dash catalogue/combinations | global | Loading/error/no-data states, both combo routes, dashboard selection, persisted layout, responsive fit, replay-driven values, disconnect state, and route navigation | FM combo-2 completed-lap pace values remain fixture-limited by bounded replay |
| Dev tools | global | Recording list/viewer, AC Evo parsed/fields/verify/hex tabs, replay scrubber, disconnect isolation, invalid/empty responses, dump import, and cleanup | Native provider status is reported honestly when game process is absent |

## Same-lap dynamic field contract (234 source checks)

Recorded catalog tests apply **234 game-specific dynamic packet-field contracts to one representative lap at a time**. They run committed captures through production parsers and retain game/lap identity while measuring each required range. Browser coverage is narrower: `seeded-telemetry.spec.ts` currently checks Speed, RPM, Gear, Throttle, Brake, and Steer at start/middle/end for each game. Do not describe those 30 browser field contracts as full catalog presentation coverage.

Classify each value explicitly:

- **Dynamic:** continuous motion/input value expected to vary within selected lap. Source test must report observed and required range.
- **Static:** metadata stable for session/lap, such as game, car, track, units, and session identity.
- **Event:** lap/session events or transitions, such as pit, sector, flags, compounds, and timing boundaries. Assert event ordering and lap ownership.
- **Unsupported:** adapter cannot provide field. Expected result is explicit `Unavailable`/null presentation according to catalog contract; it is not a parser failure.
- **Fixture-limited:** adapter supports field, but committed fixture does not contain enough packets/events to prove it. Report fixture limitation; do not relabel as unsupported.

Pass criteria for source dynamics: all 234 contracts meet their same-lap range without accepting `undefined`, neighboring-lap data, or placeholder values. Pass criteria for browser presentation remains separate: each applicable catalog value renders with correct value, unit, source classification, and unsupported/static/event state.

### Values that should not change every lap

| Value class | Why | Required assertion |
| --- | --- | --- |
| Car, class, PI, drivetrain, cylinders, car/track ordinals | Identity/configuration, not motion | Stable within session/lap and correct for selected record |
| Engine idle/max RPM, tyre compound, setup values | Vehicle/setup configuration | Stable until configuration event |
| Session type, total-lap count, session identity | Session metadata | Stable until session transition |
| Lap number, sector, pit state, flags, penalties, DRS/ERS availability, damage | Event/state driven | Assert only with fixture containing transition; verify ordering and lap ownership |
| Optional cold tyre pressure | Snapshot/setup source for adapters that do not stream pressure | Assert source/provenance and freshness, not unconditional range |
| Unsupported adapter channels | Source cannot provide value | Render `Unavailable`; never present fabricated zero as live telemetry |

### Known committed-fixture limits

- ACC fuel remains exactly `62` through two complete fixture laps. Current fixture proves decoding, not consumption; capture fuel burn enabled and a long enough stint before requiring visible decrease.
- ACC and AC Evo tyre-wear samples remain `0` in current native fixtures. Capture wear-enabled laps before requiring degradation.
- F1 tyre pressures are static inside representative lap. Treat as setup/static until a fixture proves an in-lap pressure transition.
- iRacing tyre temperature/health are pit snapshots and pressure is a cold/static source, not continuous live data.
- iRacing suspension fixture is short; it cannot prove continuous shock-travel UI behavior. Capture a complete lap with bumps/kerb load.
- Pit, sector, flag, compound, damage, DRS, and ERS checks require fixtures containing relevant transitions. Absence of transition is fixture-limited, not a pass.

- The bounded FM dashboard replay does not create completed sector-best history for combo 2. `Lap time`, `Optimum`, `Average`, `Best`, and pace values therefore remain fixture-limited; the browser assertion requires the explicit no-completed-laps state rather than fabricated estimates.
- The iRacing seed has no two-valid-lap same-track/car pair, so distinct-pair Compare coverage is conditionally skipped while incomplete-selection behavior remains covered.
- Repository has no MoTeC `.ld` fixture and no FM lap without telemetry. Those two import/empty-state checks remain conditionally skipped.

## Executable workflows

Commands below are owner-neutral. Run from repository root unless noted.

### Functional E2E gate

Canonical PR-equivalent dev-server gate:

```sh
bun install
E2E_SERVER_MODE=dev bun run test:e2e
```

PowerShell:

```powershell
$env:E2E_SERVER_MODE='dev'; bun run test:e2e
```

`test:e2e` selects `fresh-install`, `tunes`, `seeded-e2e`, `mobile-device`, and `tablet-device`. Reusable `.github/workflows/playwright.yml` accepts the same project flags, server mode, runner, optional `dist` artifact, and result artifact name. `playwright-dev.yml` invokes it on Linux in dev mode; release workflow invokes it on Windows in compiled mode. Both upload `playwright/test-results/` and `playwright/screenshots/` with `if: always()`, avoiding a duplicate per-project job matrix.

Diagnose only seeded behavior with:

```sh
cd playwright && E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test --project=seeded-e2e -g "Forza Motorsport 2023"
```

Compiled-server lane uses `dist/raceiq.exe` on Windows (`dist/raceiq` elsewhere). Build first, leave `E2E_SERVER_MODE` unset or set it to `compiled`, and select `PW_SERVER_SET=fresh` or `tunes` when isolating one server. `RACEIQ_E2E=1` is set only for seeded harness server so fixture import/replay routes stay unavailable in normal production.

Seeded runtime data defaults under ignored `playwright/test-results/test-data-seeded`; launchers wipe it before each run. Never point seeded E2E at tracked fixtures or user data. Tests use committed recordings plus production parser/import paths and must restore any note/import/delete mutation in `finally`.

CI reality: non-draft pull requests call dev-server gate through `playwright-dev.yml`; release/manual workflow calls compiled Windows gate with `raceiq-dist-windows`. Local workflow inspection confirms project selection and artifact paths, but only an observed GitHub run confirms runner behavior. Mobile/tablet projects use real Playwright touch/user-agent emulation in Chromium; they are not physical-device tests.

### Recorded same-lap telemetry contract

Use isolated test storage. POSIX:

```sh
DATA_DIR="$PWD/.data-test" bun test test/e2e test/telemetry-catalog-fm-2023-e2e.test.ts test/telemetry-catalog-f1-2025-e2e.test.ts test/telemetry-catalog-acc-e2e.test.ts test/telemetry-catalog-ac-evo-e2e.test.ts test/telemetry-catalog-iracing-e2e.test.ts
```

Windows PowerShell:

```powershell
$env:DATA_DIR=(Join-Path (Get-Location) '.data-test')
bun test test/e2e test/telemetry-catalog-fm-2023-e2e.test.ts test/telemetry-catalog-f1-2025-e2e.test.ts test/telemetry-catalog-acc-e2e.test.ts test/telemetry-catalog-ac-evo-e2e.test.ts test/telemetry-catalog-iracing-e2e.test.ts
```

Failures must report game, recording, selected lap segment, semantic or packet field, observed range, and required range.

### Responsive app screenshots

```sh
cd playwright && E2E_SERVER_MODE=dev PW_SCREENSHOT_ONLY=1 PW_SEED_SCREENSHOTS=1 bunx playwright test --project=mobile-screenshots
```

Artifacts land under `playwright/screenshots/mobile/` (gitignored). Review layout at phone, tablet boundary, and desktop cases. Treat output as visual evidence only.

### Storybook snapshots

```sh
cd client
bun run snapshot:test
```

For canonical baseline generation, use pinned environment workflow/process rather than updating snapshots on an arbitrary host:

```sh
bun run snapshot:docker
```

Snapshots cover reusable primitives and dashboard stories. They do not cover route data or native adapter semantics.

### Native recording and playback

Capture with game-specific commands, drive one complete lap plus required events, then stop with `Ctrl+C` so final frame flushes:

```sh
bun run dev:dump:fm
bun run dev:dump:f1
bun run dev:dump:acc
bun run dev:dump:ac-evo
bun run dev:dump:iracing
```

Compress selected recordings for fixtures:

```sh
bun run gzip:recording path/to/recording.bin
```

Replay through existing parser/lap assertions and retain game id in filename. Native ACC, AC Evo, and iRacing capture requires Windows game process, telemetry source, and permissions; F1/FM require their UDP source. A missing source is capture-blocked, not a passing unsupported check.

## Remaining checklist

### Automated

- [x] Verify native five-game same-lap dynamic contracts: 5 tests, 294 assertions, 0 failures on 2026-08-03.
- [x] Keep full dev-server `seeded-e2e` route and interaction project green: 169 passed and 3 explicit fixture-conditional skips on 2026-08-04.
- [x] Run compiled Windows parity against `dist/raceiq.exe`: `fresh-install` 34 passed and `tunes` 7 passed on 2026-08-04.
- [x] Cover catalog-driven units, provenance, static/event categories, unsupported values, and replay-driven dynamic values across all supported games.
- [x] Cover Settings, navigation, Chats, Sessions, Analyse, Compare, Tracks, Cars, Setups, Experiments, Raw, Dash, and Dev interactions listed in the matrix.
- [x] Run responsive screenshot registry: 97/97 phone, tablet-boundary, desktop, and interaction captures passed on 2026-08-04.
- [x] Run Chromium device emulation: Pixel 7 and iPad (gen 7) owned cases passed; cross-project copies skipped by ownership as designed.
- [x] Validate reusable workflow project selection and unconditional result/screenshot artifact upload without redundant project matrix jobs.
- [x] Keep telemetry catalog generated artifacts and hard-coded inventory counts current.

### Cannot confirm locally — physical fixture capture

Unchecked items below are fixture-blocked, not passes and not unsupported product behavior:

- [ ] **ACC fuel consumption:** current fixture remains at `62` litres through two complete laps. Capture a longer stint with fuel consumption enabled, then verify a same-lap or lap-to-lap decrease.
- [ ] **ACC and AC Evo tyre wear:** current native fixtures remain at `0`. Capture wear-enabled sessions long enough to produce measurable degradation.
- [ ] **F1 tyre pressure movement:** current representative lap contains static pressures. Keep pressure classified as setup/static unless a new authoritative fixture proves an in-lap transition.
- [ ] **iRacing tyre transitions:** temperature and health are pit snapshots; pressure is a cold/static source. Capture a pit stop with refreshed tyre data before asserting transitions.
- [ ] **iRacing suspension movement:** current fixture is too short to prove continuous shock travel. Capture a complete lap with bumps and kerb loading.
- [ ] **Event/state transitions:** capture sessions containing pit entry/exit, sector changes, flags, compound changes, damage, penalties, and DRS/ERS transitions before asserting those states.
- [ ] Preserve source settings, game version, car, track, session type, timestamps, and capture conditions for every replacement fixture.
- [ ] Re-import every new recording and confirm game, car, track, packet count, lap count, selected lap identity, and same-lap field results.

### Cannot confirm locally — external CI and devices

- [ ] Observe seeded functional, responsive screenshot, and emulated-device suites pass in CI's pinned browser environment; local success does not confirm CI behavior.
- [ ] Add and run a Windows/native capture lane for ACC, AC Evo, and iRacing; retain a UDP capture lane for F1 and FM.
- [ ] Exercise critical touch flows on physical phone/tablet hardware; Playwright device emulation does not prove OS/browser integration.

### Not applicable

- [x] Screenshots cannot certify telemetry semantics; no screenshot-only completion claim.
- [x] Storybook cannot certify route integration or native adapter behavior.
- [x] Unsupported fields do not require fabricated fixture data; they require explicit unsupported presentation.
- [x] Native capture is not required for a field already proven by authoritative committed replay fixture; record fixture provenance instead.
