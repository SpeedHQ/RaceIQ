---
name: AI eval provider = Gemini 3 Flash
description: For RaceIQ AI evaluators, pin provider to Gemini 3 Flash — not OpenAI/GPT
type: feedback
originSessionId: c7559b1f-7802-4ae8-a635-bda973f43682
---
Use Gemini (model `gemini-3-flash`, Mastra ID `google/gemini-3-flash`) as the pinned provider for AI evals and reference runs in RaceIQ. Do not default to OpenAI/GPT.

**Why:** User explicitly directed ("do not use gpt, use gemini" → "3 flash") on 2026-04-18. Project already defaults to Gemini in `mastra/model.ts:14` and `server/ai/providers.ts`. Keeps evals aligned with the provider most users run.

**How to apply:** When writing eval configs, CI env vars, fixtures, or scorer examples for RaceIQ, set `EVALS_PROVIDER=gemini`, `EVALS_MODEL=gemini-3-flash`. API key env var: `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`). Do not insert OpenAI/Anthropic examples unless the user asks.
