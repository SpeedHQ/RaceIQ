# OpenAI reasoning levels contract

Plans: [UI](openai-reasoning-ui-plan.md), [backend](openai-reasoning-backend-plan.md). Scope: one Medium/None field per section; no separate switch or changes to other providers. Keep option values in English.

## Settings boundary

Existing `GET /api/settings` returns required booleans `aiReasoningEnabled` and `chatReasoningEnabled`. Existing `PUT /api/settings` accepts either as an optional, non-null boolean; omission leaves that setting unchanged. For example, `{ "aiReasoningEnabled": false }` disables analysis reasoning without changing chat. Existing auth, response and error behavior apply; an invalid boolean is rejected without persisting changes. Missing persisted fields default to `true`.

Each flag applies to its corresponding official OpenAI workflow: lap and comparison analysis, or lap, comparison and setup chat. On preserves `medium`. Off sends `reasoning.effort: "none"` only when supported. Required reasoning stays `medium` regardless of a saved false. Non-reasoning OpenAI models keep the SDK's omission behavior. Existing Responses storage behavior, tools and other providers stay unchanged. The shared model capability helper governs both UI and backend. Preferences survive model/provider changes without sending incompatible values.

## Acceptance and integration

- AC1 / E1: Start the app with isolated settings and OpenAI model discovery fixtures. Open AI settings; expect both fields set to Medium. Select None for Analysis; confirm via live settings API that Chat remains Medium. Reload, confirm both states, then reverse the values.
- AC2 / E2: Change to GPT-4.1 mini, a known required-reasoning model and a compatible provider. Expect hidden, disabled at Medium with help text, and hidden respectively. Switch back; confirm saved preference returns. Exercise keyboard selection and verify save failure uses existing error feedback.
- AC3 / E3: Exercise actual lap analysis and chat entry points with instrumented upstream Responses fixtures. Read saved settings in production or via existing injected dependencies. Assert the applicable `none` or `medium` and proper tool payloads, structured output and chat streaming. Cover required reasoning with saved false, omitted reasoning with GPT-4.1 mini, and unchanged compatible/provider routing with targeted integration suites.
- AC4 / E4: Use the live settings API to submit an invalid boolean; verify rejection and no partial overwrite. Default old settings lacking both fields to on.

Main session owns the shared helper and final integration verification. Run and report E1–E4; fixtures may replace upstream discovery/generation, not the settings API or Mastra execution under test.
