### Features

- Choose DeepSeek for analysis, chat, auto-tune and driver profiles with its own API key. The model picker reads the models available to that key instead of using a fixed list, preselects `deepseek-flash`, keeps tool calls working, and only offers image attachments on models that accept them.
- Set the OpenAI reasoning level independently in AI Analysis and AI Chat using the same searchable picker as model selection. A star marks Medium as recommended. Supported levels vary by model.

### Fixes
- Show the correct gear in the Portable Combo dashboard for Automobilista 2.
- Preserve Automobilista 2 parser state when splitting recorded sessions into laps, allowing seeded sessions to migrate and replay correctly.
- Run lap analysis and AI chat with OpenAI models that use function tools and reasoning together.
- OpenAI model pickers in Settings list only GPT-6 and newer text models.

### Internal
- Select affected verification jobs before allocating CI runners. Keep full coverage when CI cannot verify which jobs are affected.
- Allow CI replay WebGPU tests to use software adapters; hardware coverage is not guaranteed.
- Require an explicitly configured model for AI evaluation runs.
- Keep ongoing release notes in `UNRELEASED.md` and move them into `CHANGELOG.md` only when publishing a release.
- Run RaceIQ in the native macOS app with existing lap data and saved network access; control login startup and whether closing the window quits the app.
