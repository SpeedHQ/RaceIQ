## Unreleased

### Features
- Automatic driver profile metrics with optional, configurable background AI coaching and auditable run history
- OpenAI Codex CLI provider using authenticated ChatGPT subscription access for AI analysis and chat
- Runtime-discovered iRacing cars and tracks, resolved by the SDK's native identifiers
- Support for iRacing's source-defined sector layouts, including two-sector ovals and layouts with more than three sectors
- View all release notes since your installed version in the app

### Fixes
- Hide unfinished F1 Experiments and iRacing integrations from production releases
- Clean up settings and onboarding wizard controls so navigation, progress indicators, and wheel cards render correctly
- Render experiment focus choices as wrapping cards, remove the experiment table shell, and underline Analyse tabs
- Report missing AI model settings instead of silently selecting a provider default
- Expose Codex subscription models and preserve comparison and setup analysis across AI features
- Keep AI chat drafts editable and show submitted prompts with the loading state immediately across chat surfaces

- Keep the Compare loading message hidden after comparison data is available
- Cover the full page when settings are open so background content is consistently dimmed and dismissible
- Guide drivers to AI settings with neutral primary actions when their provider, credentials, or model is not configured
- Use semantic tabs for Analyse visualization modes and Data/Insights navigation
- Keep Compare panel framing consistent by removing the track-map card outline and completing the AI Analysis panel border
- Keep setup track names neutral and expanded setup details free of accent backgrounds
- Keep expanded session lap tables aligned and show sector columns when lap sector timing is unavailable
- Show all registered games in storage settings, including games with no recording files
- Match primary button backgrounds to the neutral gray button surface
- Highlight the active sector-blip setting with a cyan border
- Keep desktop-only analysis and comparison pages available on wide, low-height displays
- Resize the comparison track map with a persisted splitter and keep the AI Analysis control right-aligned
- Keep table text, guide cards, and setup rows consistently scaled without overflowing, and align Tracks sorting with Track Detail tabs without extra divider spacing
- Use one consistent table layout, spacing, alignment, and borderless sortable-header style throughout dashboards and analysis views
- Open Forza setups directly in the tune browser without obsolete Car Tunes and Wheel / FFB tabs
- Place setup car and track filters beside setup actions for faster access
- Use compact, borderless searchable filters for setup cars and tracks
- Remove the setup source-row container styling and keep refresh aligned with its filters

### Internal
- Renamed generic session recorder API to reflect support for UDP and shared-memory telemetry
- Centralized settings-aware AI provider resolution with request-scoped credentials and shared readiness handling
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
