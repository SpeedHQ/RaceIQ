## Unreleased

### Features
- Persisted cross-game race results, qualifying/podium/fastest-lap flags, pit ledgers, strategy availability, and idempotent historical backfill
- Automatic driver profile metrics with optional, configurable background AI coaching and auditable run history
- Runtime-discovered iRacing cars and tracks, resolved by the SDK's native identifiers
- Support for iRacing's source-defined sector layouts, including two-sector ovals and layouts with more than three sectors
- View all release notes since your installed version in the app

### Fixes

- Ignore one-frame iRacing lap-counter resets that created invalid duplicate lap numbers in session recaps
- Honor Analyse and Compare URL state so saved chats open with their AI panel visible and comparison cursor links are preserved
- Restore experiment version loading, editing, deletion, and recovery after the version API rename
- Keep Analyse insight navigation aligned on desktop and move the timeline tracking bar when stepping through events
- Do not report wheel lockups or brake traction loss for iRacing laps when source telemetry cannot identify them
- Show fuel used in litres for iRacing, ACC, and Assetto Corsa Evo instead of treating litres as percentages
- Hide unsupported telemetry channels and label iRacing pit snapshots instead of presenting normalized zeroes as live data
- Resolve car and track names on the global home page in each lap's game context
- Treat tracks without optional boundary geometry as available instead of failed requests
- Open Analyse from home and session recaps without a full-page white flash
- Keep Analyse responsive while loading and playing large laps or recovering from server disconnects
- Prevent 2D and 3D Analyse playback from exhausting browser memory during telemetry updates
- Keep repeated client errors and diagnostics logs from consuming unbounded memory, network, and disk space
- Restore lap and session history when upgrading databases affected by overlapping schema migrations
- Keep the Compare loading message hidden after comparison data is available
- Cover the full page when settings are open so background content is consistently dimmed and dismissible
- Guide drivers to AI settings with neutral primary actions when their provider, credentials, or model is not configured
- Use semantic tabs for Analyse visualization modes and Data/Insights navigation
- Keep Compare panel framing consistent by removing the track-map card outline and completing the AI Analysis panel border
- Keep setup track names neutral and expanded setup details free of accent backgrounds
- Keep expanded session lap tables aligned and show sector columns when lap sector timing is unavailable
- Show all registered games in storage settings, including games with no recording files
- Keep older lap telemetry available when legacy storage is the only replay source or a raw capture fails
- Make every app workspace reflow across phone, tablet, odd-shaped, and desktop windows without blocking device or rotation gates
- Match primary button backgrounds to the neutral gray button surface
- Highlight the active sector-blip setting with a cyan border
- Keep analysis and comparison pages usable on wide, low-height displays
- Resize the comparison track map with a persisted splitter and keep the AI Analysis control right-aligned
- Keep the iRacing analysis car indicator aligned with track direction in fixed and follow map views
- Show corner and straight times on iRacing analysis laps without world-position telemetry
- Keep table text, guide cards, and setup rows consistently scaled without overflowing, and align Tracks sorting with Track Detail tabs without extra divider spacing
- Use one consistent table layout, spacing, alignment, and borderless sortable-header style throughout dashboards and analysis views
- Open Forza setups directly in the tune browser without obsolete Car Tunes and Wheel / FFB tabs
- Place setup car and track filters beside setup actions for faster access
- Use compact, borderless searchable filters for setup cars and tracks
- Remove the setup source-row container styling and keep refresh aligned with its filters

### Internal
- Distinguish clean page reloads from unexpected browser termination in client diagnostics
- Keep production builds from bundling development-only Mastra dependencies
- Added complete telemetry-first semantic catalog with units, descriptions, per-game fidelity mappings, full parser/setup source inventories, stable iRacing SessionInfo setup leaves, detailed sector relationships, and persisted detailed tire temperatures
- Restored live-dashboard Storybook runtime context and added same-renderer local visual comparison before canonical Linux baseline generation
- Expanded visual regression coverage to 97 fixture-seeded responsive app states plus 17 Storybook states, covering every game, high-risk screens, track and experiment details, reusable primitives, navigation, dialogs, and viewport-positioned menus
- Added a local main-versus-worktree UI comparison report using the same responsive and Storybook screenshot inventory as pull-request previews
- Renamed generic session recorder API to reflect support for UDP and shared-memory telemetry
- Stabilized Storybook dashboard capture readiness, aligned PR preview comparison with Playwright's material-diff policy, and restricted baseline writes to the pinned Linux renderer
- Made Storybook snapshots own an exact-port server and retry cold preview preparation
- Restored the ACC live-dashboard fuel bar in fixture-backed previews
- Consolidated live dashboard routing across all supported games while preserving game-specific URLs
- Deterministic iRacing recording and replay coverage through the production parser pipeline
- Preserve complete iRacing SessionInfo YAML in recordings while keeping historical captures replayable and telemetry deltas compact
- Consolidated per-game car, track, and compare routes into shared dynamic game routes
- Added a disposable development database seed from committed telemetry fixtures
- Add fixture-seeded cross-game route and lap playback end-to-end coverage
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
