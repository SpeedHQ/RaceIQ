## Unreleased

### Features
- Persisted cross-game race results with qualifying, podium, fastest-lap, pit, strategy, and position-timeline summaries, plus idempotent historical backfill

### Fixes
- Raise Windows timer resolution during ACC and AC Evo capture so shared-memory polling no longer collapses to the default ~64 Hz tick

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
- Added complete telemetry-first semantic catalog with units, descriptions, per-game fidelity mappings, full parser/setup source inventories, stable iRacing SessionInfo setup leaves, detailed sector relationships, and persisted detailed tire temperatures
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
