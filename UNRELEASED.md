### Features
- Use your ChatGPT subscription with RaceIQ and choose from GPT-6 and newer models. AI Chat shows the selected model and its input limit when known.
- AI Chat keeps Send beside the message field and puts Compact & New chat in the Chat actions menu.
- Record and replay F1 2026 Season Pack telemetry, including its new cars and circuits, energy recovery, active aero, and overtake data.
- Show F1 2026 ERS mode, energy availability, active aero, and overtake data in live telemetry and lap analysis.

### Fixes
- Keep recording telemetry when a possible lap start is never confirmed.
- Retry temporary Claude service failures during analysis without waiting through long rate-limit windows.
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.
- Show session types for all supported games on the Sessions list and remove the repeated session type from expanded lap rows.
- Show the correct session type on the Sessions page for recorded and imported AC EVO sessions, even when the game reports its name late. Prevent pit results from marking a second lap as an out-lap.
- Open the macOS app even when another service is using the default RaceIQ dashboard port.
- Keep one full F1 lap replay when a flashback crosses the finish line and you drive across it again.
- Keep F1 replay from the start of the lap through the last recorded point after a mid-lap flashback, even if you quit before the finish.
- Correct F1 brake-bias percentages in Replay and align F1 car wheels and track overviews with replay orientation.
- Keep F1 races in the same session when telemetry briefly reports a zero session UID.

### Internal
- Move AI prompts and provider runtime into the assistant workspace package and consolidate provider registration, including ChatGPT subscriptions.
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
- Select affected verification jobs before allocating CI runners. Keep full coverage when CI cannot verify which jobs are affected.
- Keep F1 2025 track-guide coverage checks scoped to F1 25 entries as F1 2026 identities join the catalog.
- Verify seeded Playwright flows against the trusted local origin and stabilize replay and capture export checks.
