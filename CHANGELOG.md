## Unreleased

### Breaking
- Store primary database as `app.db` and automatically move older `forza-telemetry.db` files; resolve dual-file directories before startup because RaceIQ refuses to overwrite either

### Features
- Classify imported laps as Mine or Others, filter sessions and owned statistics by ownership, preserve cross-tab selections, and label Compare/Analyse laps with ownership
- Persisted cross-game race results with qualifying, podium, fastest-lap, pit, strategy, and position-timeline summaries, plus idempotent historical backfill
- Configure driver-profile AI output tokens with provider-advertised limits
- Use simulator-independent semantic telemetry for live dashboards while keeping native packet inspection in the development panel and recording bytes unchanged

- Detect imported file contents before accepting ZIP/BIN session data and reject unrelated archives
### Fixes
- Raise Windows timer resolution during ACC and AC Evo capture so shared-memory polling no longer collapses to the default ~64 Hz tick
- Make stale-session reprocessing recoverable with retry and dismissal actions, accessible progress states, and clear failure feedback
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
- Draw iRacing left-turning oval laps in the correct direction on Analyse track maps
- Honor Analyse and Compare URL state so saved chats open with their AI panel visible and comparison cursor links are preserved
- Restore experiment version loading, editing, deletion, and recovery after the version API rename
- Keep Analyse insight navigation aligned on desktop and move the timeline tracking bar when stepping through events
- Do not report wheel lockups or brake traction loss for iRacing laps when source telemetry cannot identify them
- Show fuel used in litres for iRacing, ACC, and Assetto Corsa Evo instead of treating litres as percentages
- Align game metric contracts with catalog-backed semantic bindings; show Forza source-native Grip Ask and normalized lateral slip while hiding unsupported physical metrics.
- Hide unsupported telemetry channels and label iRacing pit snapshots instead of presenting normalized zeroes as live data
- Resolve car and track names on the global home page in each lap's game context
- Treat tracks without optional boundary geometry as available instead of failed requests
- Open Analyse from home and session recaps without a full-page white flash
- Keep Analyse responsive while loading and playing large laps or recovering from server disconnects
- Prevent 2D and 3D Analyse playback from exhausting browser memory during telemetry updates
- Keep repeated client errors and diagnostics logs from consuming unbounded memory, network, and disk space
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
- Restore Analyse Data panel rows, section grouping, source-native tyre temperatures, copied values, F1 ERS/DRS details, and green throttle traces on both 2D and 3D views

### Internal
- Replace Biome with Oxc for repository linting and formatting
- Consolidate coding-agent guidance in `AGENTS.md` and remove duplicate guidance file
- Catch repository-wide staged lint violations before commit and generate localization modules before root type-checking
- Preserve complete exports when startup-job tests mock background schedulers
- Keep tune prompt formatting compatible with game-specific setup blobs
- Require repo-wide Biome and root TypeScript checks in CI, backed by the Biome 2.5.6 schema and recommended preset syntax
- Allow telemetry catalog validation to bootstrap when the base branch has no committed catalog
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
