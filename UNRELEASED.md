### Features

- Use your ChatGPT subscription with RaceIQ and choose from GPT-6 and newer models. AI Chat shows the selected model and its input limit when known.
- AI Chat keeps Send beside the message field and puts Compact & New chat in the Chat actions menu.

### Fixes
- Retry temporary Anthropic service failures so analysis can recover without another request from you.
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.
- Show session types for all supported games on the Sessions list and remove the repeated session type from expanded lap rows.
- Show the correct session type on the Sessions page for recorded and imported AC EVO sessions, even when the game reports its name late. Prevent pit results from marking a second lap as an out-lap.
- Open the macOS app even when another service is using the default RaceIQ dashboard port.

### Internal
- Refactor game-owned catalog validation and MoTeC integration.
- Move AI prompts and provider runtime into the assistant workspace package and consolidate provider registration, including ChatGPT subscriptions.
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
- Select affected verification jobs before allocating CI runners. Keep full coverage when CI cannot verify which jobs are affected.
