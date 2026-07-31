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

### Internal
- Added a local main-versus-worktree UI comparison report using the same responsive and Storybook screenshot inventory as pull-request previews
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
