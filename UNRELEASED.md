### Features
- Show F1 2026 active aero, overtake, and energy availability in live telemetry and lap analysis.
- Decode experimental F1 2026 UDP telemetry and preserve its additional packet data in recordings for replay.
- Choose DeepSeek for analysis, chat, auto-tune and driver profiles with its own API key. The model picker reads the models available to that key instead of using a fixed list, preselects `deepseek-flash`, keeps tool calls working, and only offers image attachments on models that accept them.

### Fixes
- Correct F1 brake-bias percentages in Replay and align F1 car wheels and track overviews with replay orientation.
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.

### Internal
- Add a native macOS shell that builds RaceIQ as a local app artifact and supervises its bundled backend.
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
