## Unreleased

### Features
- Persisted cross-game race results, qualifying/podium/fastest-lap flags, pit ledgers, strategy availability, and idempotent historical backfill
- Automatic driver profile metrics with optional, configurable background AI coaching and auditable run history
- Runtime-discovered iRacing cars and tracks, resolved by the SDK's native identifiers
- Support for iRacing's source-defined sector layouts, including two-sector ovals and layouts with more than three sectors
- View all release notes since your installed version in the app

### Fixes

- Show all registered games in storage settings, including games with no recording files
- Make every app workspace reflow across phone, tablet, odd-shaped, and desktop windows without blocking device or rotation gates
- Match primary button backgrounds to the neutral gray button surface
- Highlight the active sector-blip setting with a cyan border
- Keep desktop-only analysis and comparison pages available on wide, low-height displays
- Resize the comparison track map with a persisted splitter and keep the AI Analysis control right-aligned

### Internal
- Restored live-dashboard Storybook runtime context and added same-renderer local visual comparison before canonical Linux baseline generation
- Expanded visual regression coverage to 97 fixture-seeded responsive app states plus 17 Storybook states, covering every game, high-risk screens, track and experiment details, reusable primitives, navigation, dialogs, and viewport-positioned menus
- Added a local main-versus-worktree UI comparison report using the same responsive and Storybook screenshot inventory as pull-request previews
- Renamed generic session recorder API to reflect support for UDP and shared-memory telemetry
- Stabilized Storybook dashboard capture readiness, aligned PR preview comparison with Playwright's material-diff policy, and restricted baseline writes to the pinned Linux renderer
- Made Storybook snapshots own an exact-port server and retry cold preview preparation
- Restored the ACC live-dashboard fuel bar in fixture-backed previews
- Consolidated live dashboard routing across all supported games while preserving game-specific URLs
- Deterministic iRacing recording and replay coverage through the production parser pipeline
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
