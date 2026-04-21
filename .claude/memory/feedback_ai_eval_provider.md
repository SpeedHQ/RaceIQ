---
name: AI default model = gemini-flash-latest
description: For RaceIQ AI defaults + evals, pin provider to Gemini with model alias `gemini-flash-latest` — not OpenAI/GPT
type: feedback
originSessionId: c7559b1f-7802-4ae8-a635-bda973f43682
---
Use Gemini (model `gemini-flash-latest`, Mastra ID `google/gemini-flash-latest`) as the default provider across RaceIQ AI code — production defaults AND eval reference runs. Do not default to OpenAI/GPT.

**Why:** User direction evolved over 2026-04-18 session: first "do not use gpt, use gemini", then "3 flash", then "default model to gemini flash latest in settings if user hasn't picked a model". The alias `gemini-flash-latest` is self-updating as Google ships new flash revisions, so it beats pinning a specific version (e.g. `gemini-3-flash`) for the default path.

**How to apply:**
- Fresh `AppSettings` defaults: `aiProvider: "gemini"`, `aiModel: "gemini-flash-latest"`, same for `chatProvider` / `chatModel` (see `server/settings.ts`).
- Fallback strings in `mastra/model.ts`, `server/ai/chat-agent.ts`, `server/ai/providers.ts::runGemini`, `server/routes/lap-routes.ts` all use `gemini-flash-latest`.
- Eval harness (`mastra/evals/eval-agents.ts`) and CI workflow env vars (`.github/workflows/build-test.yml`) use `EVALS_PROVIDER=gemini`, `EVALS_MODEL=gemini-flash-latest`.
- API key env var: `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`).
- Do not insert OpenAI/Anthropic examples unless the user explicitly asks.
- When a user has explicitly picked a model in Settings (non-empty `settings.aiModel`), always honour that choice over the fallback.
