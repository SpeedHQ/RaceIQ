# End-to-end testing

This page is source of truth for RaceIQ browser audits. It separates semantic checks from visual evidence and records what still needs a real seeded run. A green screenshot is not proof that telemetry semantics, route data, or unsupported values are correct.

## Status

**Audit result:** not complete. Five-game native parser dynamics and the 140-test dev-server functional E2E gate pass. Route health is broader than interaction coverage; unsupported/static/event presentation, several page controls, compiled-server parity, real devices, and transition-bearing captures remain open.

**Done when:** every row in route and game matrices has an executable functional check; same-lap assertions pass for all 234 game-specific dynamic field contracts; visual suites produce expected artifacts; native recordings cover required capture conditions; remaining checklist below is empty or explicitly marked not applicable.

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

| Surface | Games | Automated now | Missing or blocked coverage |
| --- | --- | --- | --- |
| Onboarding, home, settings | all | Fresh-install wizard; game links; Today/All Time periods; recent-lap navigation; Units save/reload/reset | Other period tabs; empty/error states; language, connection, wheel, sound, storage, AI, developer, diagnostics, updates, and about controls |
| Game landing | all | Route health; global card navigation | Game-page primary actions; empty/error states |
| Live dashboard | all | Committed replay changes a visible live value for every game (FM/ACC/AC Evo/iRacing Current lap time, F1 ERS), changes Raw Current lap time for all five, and verifies FM disconnect/reconnect | Other visible channels and controls; disconnect/reconnect for F1/ACC/AC Evo/iRacing; pit/driver state transitions |
| Sessions and recap | all | Route health; FM search/empty result, recap, ZIP export, note persistence/restoration, delete-confirm cancellation | Recorded/Imported tabs, pagination, compare/analyse links, context actions, successful deletion, MoTeC import, loading/error/true-empty states |
| Analyse | all | Real-lap load and six common metrics at start/middle/end for all games; FM lap selection, 2x playback, keyboard scrub, notes, CSV/bin export, bin import, delete cancellation | Track/car/tune selectors, all speed presets, charts/Insights, map/layout controls, F1 setup/guide, AI actions, successful deletion, loading/error/no-telemetry states |
| Compare | all | FM distinct-lap selection, same-lap rejection, API reload, canvases, map-width keyboard control | Other games; trace values/deltas/cursor, layout modes, map interactions, AI actions, loading/error states |
| Driver | FM, F1, ACC, AC Evo | Deterministic aggregate/API match and no-provider disabled state | Filters, history, empty/error states, configured provider run/retry; visible `All <game> laps` control currently has no action |
| Experiments | F1, ACC, AC Evo | F1 create/focus/lap import/history/archive | ACC/AC Evo; list/open/review/version comparison, add base, setup/chat, attach/cancel, delete/undo/history, empty/error states |
| Chats | all | Seeded FM list/history; Analyse and Compare open into matching AI workspaces; delete-confirm cancellation; no-provider Analyse state | Successful deletion; other games and tune threads; loading/error/empty states; configured-provider response quality remains opt-in |
| Tracks and track detail | all | Route health; FM search/empty result and Info/Laps/Setups route state | Other games; sorting, filters, map controls, segment/sector editing, lap selection/compare/delete, guide and no-data states |
| Cars | all | Route health; FM search, RWD filter, detail, two-car compare, grid/table modes | Other games and game-specific catalogs; PI/engine filters, keyboard selection, 3D/external links, related laps/setups, no-data states |
| Setups/tunes | FM, F1, ACC, AC Evo | API-backed FM/ACC/AC Evo create/import/duplicate/delete suites; route health | Browser interaction suite; F1 CRUD/import/edit/delete; source/author/track/car filters, validation, pagination, clone/refresh/file rescan |
| Raw telemetry | all | Replay-driven visible Current lap time changes for all games | Catalog-driven populated/unsupported/static/event rows; parsed/fields/verify/hex controls and AC Evo data tabs |
| Dash catalogue/combinations | global | Catalogue links and replay-driven standalone Speed; visual cases | Dashboard toggles, loading/error/no-data, layout/selection persistence |
| Dev tools | global | Recording list/select, packet scrub, lap/raw view, and real dump import with cleanup | Pause/resume, empty/error files, verify/hex/parsed inspection, remaining destructive controls |

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

`test:e2e` owns the shared `fresh-install`, `tunes`, and `seeded-e2e` project list used by both Playwright workflows. Diagnose only seeded behavior with:

```sh
cd playwright && E2E_SERVER_MODE=dev bunx playwright test --project=seeded-e2e -g "Forza Motorsport 2023"
```

Compiled-server lane requires `dist/raceiq` or `dist/raceiq.exe`; omit `E2E_SERVER_MODE` after building. `RACEIQ_E2E=1` is set only for seeded harness server so fixture import/replay routes stay unavailable in normal production.

Seeded runtime data defaults under ignored `playwright/test-results/test-data-seeded`; launchers wipe it before each run. Never point seeded E2E at tracked fixtures or user data. Tests use committed recordings plus production parser/import paths and must restore any note/import/delete mutation in `finally`.

CI reality: non-draft pull requests run dev-server gate through `playwright-dev.yml`; compiled Windows gate runs through release/manual workflow. Neither screenshots nor Storybook are semantic gates. No current push-to-main browser gate or real mobile/touch device project exists.

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
- [ ] Keep full `seeded-e2e` route and interaction project green in both dev-server and compiled-server modes. Dev-server gate: 140/140 passed on 2026-08-03; compiled-server parity remains unchecked after this audit.
- [ ] Add catalog-driven browser assertions beyond six common metrics: units, provenance, static/event categories, and explicit unsupported presentation per applicable game route.
- [ ] Confirm failures identify game, route, lap key, field, category, and provenance with one intentional route failure and one intentional telemetry-range failure.

Automatable interaction backlog:

- [ ] Settings sections and sidebar/mobile/game-switch navigation.
- [ ] Chats successful deletion, other-game/tune threads, and loading/error/empty states.
- [ ] Successful disposable-record deletion plus Sessions imported/context/pagination/compare flows.
- [ ] Analyse secondary selectors, charts, Insights, map/layout, tune/guide, and all playback speeds.
- [ ] Compare trace/delta/cursor/layout/map behavior.
- [ ] Tracks/track-detail edit/filter/map/lap actions and per-game Cars catalogs/filters.
- [ ] Browser Setup CRUD/import/validation across FM/F1/ACC/AC Evo.
- [ ] Experiments complete lifecycle for F1/ACC/AC Evo.
- [ ] Raw inspection tabs, Dash controls/persistence, and remaining Dev controls.
- [ ] Real mobile/tablet device descriptors; current responsive checks vary viewport size only.

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

- [ ] Observe seeded functional and screenshot suites pass in CI's pinned browser environment; local success does not confirm CI behavior.
- [ ] Add and run a Windows/native capture lane for ACC, AC Evo, and iRacing; retain a UDP capture lane for F1 and FM.
- [ ] Expand and review the viewport/device matrix after route and semantic checks remain green in CI.

### Not applicable

- [x] Screenshots cannot certify telemetry semantics; no screenshot-only completion claim.
- [x] Storybook cannot certify route integration or native adapter behavior.
- [x] Unsupported fields do not require fabricated fixture data; they require explicit unsupported presentation.
- [x] Native capture is not required for a field already proven by authoritative committed replay fixture; record fixture provenance instead.
