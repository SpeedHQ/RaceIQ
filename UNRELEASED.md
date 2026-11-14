### Features
- Record and replay F1 2026 Season Pack telemetry, including its new car, circuit, energy-recovery, active-aero, and overtake data.
- Show F1 2026 active aero, overtake, and energy availability in live telemetry and lap analysis.
- Run RaceIQ in the native macOS app with existing lap data and saved network access; control login startup and whether closing the window quits the app.
- Choose DeepSeek for analysis, chat, auto-tune and driver profiles with its own API key. The model picker reads the models available to that key instead of using a fixed list, preselects `deepseek-flash`, keeps tool calls working, and only offers image attachments on models that accept them.

### Fixes
- Correct F1 brake-bias percentages in Replay and align F1 car wheels and track overviews with replay orientation.
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.

### Internal
- Keep F1 2025 track-guide coverage checks scoped to F1 25 entries as F1 2026 identities join the catalog.
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
