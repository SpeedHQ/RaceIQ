## Unreleased

### Breaking

- Store primary database as `app.db` and automatically move older `forza-telemetry.db` files; resolve dual-file directories before startup because RaceIQ refuses to overwrite either
- Rename dashboard routes from `/dash` to `/portable` and reorganize sidebar game navigation.

### Features

- Classify imported laps as Mine or Others, filter sessions and owned statistics by ownership, preserve cross-tab selections, and label Compare/Analyse laps with ownership
- Persisted cross-game race results with qualifying, podium, fastest-lap, pit, strategy, and position-timeline summaries, plus idempotent historical backfill
- Configure driver-profile AI output tokens with provider-advertised limits
- Use simulator-independent semantic telemetry for live dashboards while keeping native packet inspection in the development panel and recording bytes unchanged
- Toggle ACC and AC Evo reference racing lines alongside other Analyse overlays in both 2D and 3D views

- Load high-fidelity Compare zoom ranges faster by reusing prepared course-distance alignment data instead of recomputing full-lap spatial alignment
- Detect imported file contents before accepting ZIP/BIN session data and reject unrelated archives
- Improve ACC and Assetto Corsa Evo MoTeC `.ld`/`.ldx` imports with reconstructed racing lines, canonical telemetry, setup/ownership metadata, explicit source limitations, smoother car orientation, and better-aligned replay telemetry.

### Fixes
- Rotate Analyse GPS cursor with car heading and anchor segment and sector overlays to canonical track centerlines
- Stop showing ACC tire wear and degradation as live data because ACC does not export either channel
- Keep tuning dashboards scoped to the selected simulator and preserve unavailable track coordinates instead of drawing zero-valued positions
- Avoid fetching community leaderboard data during startup; load it when the leaderboard is first requested.
- Preserve every iRacing SDK tick around lap completion so saved laps begin at start/finish without telemetry gaps
- Show iRacing live fuel bars using tank capacity reported by simulator session data
- Show partial throttle and brake correctly in iRacing Pit Crew bars and telemetry traces
- Keep live dashboards from flickering back to Waiting for telemetry, clearly label measured source telemetry frequency, and maintain the configured browser refresh cadence
- Raise Windows timer resolution during ACC, AC Evo, and iRacing capture so native polling no longer collapses onto the default timer tick
- Make stale-session reprocessing recoverable with retry and dismissal actions, accessible progress states, and clear failure feedback
- Skip recordings from games unavailable in the current RaceIQ build during stale-session checks and bulk reprocessing
- Skip unavailable raw captures during stale-session reprocessing instead of failing the entire maintenance run
- Keep newly started session captures from being removed by concurrent storage cleanup
- Open RaceIQ faster by skipping unnecessary historical race-result work during startup
- Show actionable, neutral guidance when AI provider, credentials, or model configuration is incomplete
- Keep iRacing lap replay within saved frame boundaries so telemetry from the following lap is not included
- Report telemetry freshness from each source's own update time and mark incompatible clock domains as unknown instead of current
- Highlight only one fastest lap per sector in session and live lap tables
- Exclude pit-entry and pit-exit laps from pace, sector, consistency, improvement, and theoretical-best metrics
- Preview and import iRacing IBT recordings larger than 128 MiB without upload connection failures
- Ignore one-frame iRacing lap-counter resets that created invalid duplicate lap numbers in session recaps
- Show iRacing steering direction and signed values correctly in live views, Analyse, Compare, and saved recordings
- Roll iRacing wireframe wheels in Analyse when per-wheel rotation telemetry is unavailable
- Show iRacing lateral G-force on the correct side during turns
- Use official iRacing turn labels consistently across Analyse maps, segment lists, comparisons, chats, and tuning insights
- Draw iRacing left-turning oval laps in the correct direction on Analyse track maps
- Restore the moving car pointer on iRacing Analyse track maps
- Honor Analyse and Compare URL state so saved chats open with their AI panel visible and comparison cursor links are preserved
- Restore experiment version loading, editing, deletion, and recovery after the version API rename
- Keep Analyse insight navigation aligned on desktop and move the timeline tracking bar when stepping through events
- Do not report wheel lockups or brake traction loss for iRacing laps when source telemetry cannot identify them
- Show fuel used in litres for iRacing, ACC, and Assetto Corsa Evo instead of treating litres as percentages
- Align game metric contracts with catalog-backed semantic bindings; show Forza source-native Grip Ask and normalized lateral slip while hiding unsupported physical metrics.
- Hide unsupported telemetry channels and label iRacing pit snapshots instead of presenting normalized zeroes as live data
- Keep semantic live dashboards accurate across temperature units, unavailable tire channels, pit state, tire compounds, grip history, and traction indicators
- Resolve car and track names on the global home page in each lap's game context
- Treat tracks without optional boundary geometry as available instead of failed requests
- Open Analyse from home and session recaps without a full-page white flash
- Keep Analyse responsive while loading and playing large laps or recovering from server disconnects
- Keep Analyse 3D playback at configured 60 or 120 FPS while telemetry panels update
- Prevent 2D and 3D Analyse playback from exhausting browser memory during telemetry updates
- Keep repeated client errors and diagnostics logs from consuming unbounded memory, network, and disk space
- Keep the welcome wizard responsive and show throttle and brake input lines in its preview
- Restore lap and session history when upgrading databases affected by overlapping schema migrations
- Keep the Compare loading message hidden after comparison data is available
- Show both lap position markers on iRacing Compare maps when recordings do not contain world coordinates
- Cover the full page when settings are open so background content is consistently dimmed and dismissible
- Use semantic tabs for Analyse visualization modes and Data/Insights navigation
- Keep Compare panel framing consistent by removing the track-map card outline and completing the AI Analysis panel border
- Keep setup track names neutral and expanded setup details free of accent backgrounds
- Keep expanded session lap tables aligned and show sector columns when lap sector timing is unavailable
- Keep older lap telemetry available when legacy storage is the only replay source or a raw capture fails
- Make every app workspace reflow across phone, tablet, odd-shaped, and desktop windows without blocking device or rotation gates
- Match primary button backgrounds to the neutral gray button surface
- Highlight the active sector-blip setting with a cyan border
- Keep analysis and comparison pages usable on wide, low-height displays
- Resize the comparison track map with a persisted splitter and keep the AI Analysis control right-aligned
- Keep Compare map markers, telemetry inputs, and deltas aligned by track position after crashes, spins, shortcuts, and off-track detours
- Keep overlapping Compare lap markers on one shared map position instead of visually separating red and blue dots
- Render Compare overview hover as one white dot while retaining separate lap dots in the zoomed map
- Show corner and straight times on iRacing analysis laps without world-position telemetry
- Keep table text, guide cards, and setup rows consistently scaled without overflowing, and align Tracks sorting with Track Detail tabs without extra divider spacing
- Use one consistent table layout, spacing, alignment, and borderless sortable-header style throughout dashboards and analysis views
- Open Forza setups directly in the tune browser without obsolete Car Tunes and Wheel / FFB tabs
- Place setup car and track filters beside setup actions for faster access
- Use compact, borderless searchable filters for setup cars and tracks
- Remove the setup source-row container styling and keep refresh aligned with its filters
- Keep live telemetry stable during route and game transitions by resolving car names from each packet and skipping invalid track metadata requests
- Group rear setup controls with their populated mechanical-balance section
- Close searchable dropdowns, including Analyse lap selection, after choosing an option
- Show vehicle roll in the correct direction on the Analyse attitude indicator
- Keep Analyse attitude indicator and roll/pitch readouts moving while replaying saved laps
- Restore Analyse Data panel rows, section grouping, source-native tyre temperatures, copied values, F1 ERS/DRS details, and green throttle traces on both 2D and 3D views
- Reduce unnecessary network traffic during update checks when release tags are unchanged
- Keep live track maps from repeatedly refreshing track boundaries after boundary data loads

### Internal
- Read release notes from GitHub release bodies instead of downloading release-note assets
- Use explicit comprehensive Storybook stories for visual baselines so shared layouts cover every supported field without simulator fixture churn
- Benchmark telemetry parser and replay performance with reproducible Mitata CPU guardrails and separate report-only storage I/O measurements
- Stabilize benchmark regression checks with paired CPU samples, retained-heap probes, and counterbalanced base/current runs
- Speed Vite development startup with compact locale modules, no development declarations, cached unchanged compiles, and pinned Inlang compiler modules
- Replace first-party Zustand stores with TanStack Store and add development-only unified TanStack Devtools panels
- Parallelize Bun unit and integration test execution with dedicated suites and isolated databases
- Reject ordinary tests that are missing from or duplicated across unit and integration shards in local hooks and CI
- Keep benchmark comparison checks green for fork pull requests when comment permissions are read-only
- Speed Storybook visual snapshot CI with a test-optimized static build and concurrent workers
- Replace Biome with Oxc for repository linting and formatting
- Consolidate game raw telemetry routes behind one dynamic route and default seeded E2E runs to two workers
- Split seeded Playwright coverage across five fully parallel 15G shards to reduce runner memory pressure
- Document DeepWiki MCP as the preferred first pass for codebase discovery
- Catch repository-wide staged lint violations before commit and generate localization modules before root type-checking
- Preserve complete exports when startup-job tests mock background schedulers
- Cache prepared Compare course-distance alignment indexes per lap pair and reuse them across base and range requests to reduce repeated spatial work
- Cover Compare cursor and map-marker alignment with focused unit and seeded browser regressions
- Keep tune prompt formatting compatible with game-specific setup blobs
- Require repo-wide Biome and root TypeScript checks in CI, backed by the Biome 2.5.6 schema and recommended preset syntax
- Allow telemetry catalog validation to bootstrap when the base branch has no committed catalog
- Deduplicate telemetry catalog provenance hashes so generated review diffs stay focused on meaningful mapping changes
- Organized automated tests by domain, split oversized suites, and centralized shared test support
- Use compact real iRacing Daytona telemetry with a complete pit cycle and live estimated-lap replay in seeded development data
- Distinguish clean page reloads from unexpected browser termination in client diagnostics
- Keep production builds from bundling development-only Mastra dependencies
- Added complete telemetry-first semantic catalog with units, descriptions, per-game fidelity mappings, full parser/setup source inventories, stable iRacing SessionInfo setup leaves, detailed sector relationships, and persisted detailed tire temperatures
- Restored live-dashboard Storybook runtime context and added same-renderer local visual comparison before canonical Linux baseline generation
- Expanded visual regression coverage to 97 fixture-seeded responsive app states plus 17 Storybook states, covering every game, high-risk screens, track and experiment details, reusable primitives, navigation, dialogs, and viewport-positioned menus
- Added a local main-versus-worktree UI comparison report using the same responsive and Storybook screenshot inventory as pull-request previews
- Compare screenshot previews against each pull request's base branch and revision instead of current main
- Deterministic iRacing recording and replay coverage through the production parser pipeline
- Preserve complete iRacing SessionInfo YAML in recordings while keeping historical captures replayable and telemetry deltas compact
- Add fixture-seeded cross-game route and lap playback end-to-end coverage
- Completed fixture-seeded browser workflow coverage across Sessions, Analyse, Compare, Driver, Experiments, Chats, Tracks, Cars, Setups, Dash, developer tools, compiled binaries, and emulated devices
- Define setup form sources through typed catalog entries and expose iRacing setup metadata for future setup views

## v0.14.0 - 2026-08-05

### Features

- Analyze recent driving trends across up to 30 laps, with measured style, consistency, time-loss, and optional AI coaching
- Run versioned tuning and driving experiments in ACC and AC Evo, with setup changes, coaching drills, lap review, and car-or-driver focus
- Import MoTeC logs as normal sessions for analysis, comparison, and experiments
- Export and import individual laps or complete sessions as portable compressed captures
- View release history in Settings and see the installed version in the sidebar
- Move app navigation from the top bar into a left-hand sidebar, with a responsive mobile navigation drawer
- Copy AI Compare conversations as JSON and resume or regenerate analysis chats with complete persisted history
- Generate detailed, sector-aware lap-analysis results with consistent provider and settings handling
- Automatic driver profile metrics with optional, configurable background AI coaching and auditable run history
- Runtime-discovered iRacing cars and tracks, resolved by the SDK's native identifiers
- Support for iRacing's source-defined sector layouts, including two-sector ovals and layouts with more than three sectors
- View all release notes since your installed version in the app

### Fixes

- Keep unfinished game integrations and experiments out of production releases
- Make settings, onboarding, analysis, comparison, and experiment controls clearer and more consistent
- Show actionable guidance when AI provider, credentials, or model configuration is incomplete
- Keep chat drafts, submitted prompts, loading states, and conversation history consistent across AI surfaces
- Restore setup-seeded experiment branches and make branch deletion explicit
- Improve setup browsing with faster filters, clearer track and car context, and direct Forza tune access
- Keep analysis tables, tabs, maps, cards, and responsive layouts aligned across desktop and compact displays
- Improve session and sector tables when timing data is sparse or unavailable
- Show every registered game in storage settings, including games without recorded sessions
- Keep connection status, theme tokens, button surfaces, and sector-blip selection visually consistent

### Internal

- Renamed generic session recorder API to reflect support for UDP and shared-memory telemetry
- Centralized settings-aware AI provider resolution with request-scoped credentials and shared readiness handling
- Stabilized Storybook dashboard capture readiness, aligned PR preview comparison with Playwright's material-diff policy, and restricted baseline writes to the pinned Linux renderer
- Made Storybook snapshots own an exact-port server and retry cold preview preparation
- Restored the ACC live-dashboard fuel bar in fixture-backed previews
- Consolidated live dashboard routing across all supported games while preserving game-specific URLs
- Consolidated per-game car, track, and compare routes into shared dynamic game routes
- Added a disposable development database seed from committed telemetry fixtures
- Consolidated shared sessions, chats, analysis, driver, and experiment routes across all supported games
- Tolerate sparse screenshot antialiasing differences while preserving substantial visual regression reporting
- Centralized theme-overridable frontend colors, typography, tracking, surfaces, semantic states, telemetry, game branding, manufacturer, and team design tokens
- Added focused CSS resolution adapters for Canvas and uPlot renderers, backed by theme contract and Storybook snapshot coverage
- Updated workspace dependencies and regenerated root Bun lockfile
- Use `import.meta.dirname` in Vite config for native config-loader compatibility
- Avoid initializing Mastra observability during standalone database seeding
- Close disposable seed-test SQLite clients before removing temporary data directories

## v0.13.0 - 2026-07-16

### Features

- New lap insight detectors and server-side computation
- Static corner names and sector data from track geometry
- Session recap card with sector-coloured track map
- Curated turn numbers and track Info pages for expert guides
- AC Evo car and track extraction updates

### Fixes

- Separate Power and Torque rows in analysis
- Correct ACC centreline for corner detection
- Correct AC Evo track and car resolution

### Internal

- Backfilled from the pre-changelog GitHub release body
