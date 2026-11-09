### Features
- Choose DeepSeek for analysis, chat, auto-tune and driver profiles with its own API key. The model picker reads the models available to that key instead of using a fixed list, preselects `deepseek-flash`, keeps tool calls working, and only offers image attachments on models that accept them.

### Fixes
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.

### Internal
- Move AI prompts and provider runtime into the assistant workspace package and consolidate provider registration.
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
