# OpenAI reasoning levels contract

Plans: [UI](openai-reasoning-ui-plan.md), [backend](openai-reasoning-backend-plan.md). Scope: one reasoning level per section for official OpenAI, without a RaceIQ-maintained model allowlist. Other providers are unchanged. Display option values in English.

## Settings boundary

Existing `GET /api/settings` returns required string enums `aiReasoningLevel` and `chatReasoningLevel`. Existing `PUT /api/settings` accepts either as an optional, non-null enum: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Omission leaves that setting unchanged; for example, `{ "aiReasoningLevel": "high" }` updates only analysis. Existing auth, response and error behavior apply. Invalid values reject the entire update. Missing fields default to `medium`; migrate stored legacy `true` to `medium` and `false` to `none`, unless the corresponding new field already exists.

Each level applies to the corresponding official OpenAI workflow: lap and comparison analysis, or lap, comparison and setup chat. Mastra passes the level to the OpenAI SDK, which owns request serialization and model compatibility. Medium preserves the existing SDK behavior, including omission for non-reasoning models. If the SDK omits an explicit non-Medium level as unsupported, or OpenAI rejects the level, instruct the user to choose another level in Settings and retry. Do not expose or save a result generated without the requested explicit level. Preserve Responses storage settings, tools, and other providers. Preferences survive model and provider changes.

## Acceptance and integration

- AC1 / E1: In the real app with isolated settings and OpenAI discovery fixtures, both controls show all seven choices and default to Medium. Set Analysis to None, confirm Chat remains Medium through the settings API, and reload. Then save Analysis High and Chat Max independently.
- AC2 / E2: Change to GPT-4.1 mini, GPT-6.2 Sol and a compatible provider. The selector stays available for official OpenAI and hidden for the compatible provider; preferences survive. Verify keyboard focus and existing save error feedback.
- AC3 / E3: Exercise actual lap analysis and chat with controlled Responses. Assert `medium`, `xhigh`, `max` and `none` on the wire with supported models, and verify tools, structured output and chat streaming. For an SDK-unsupported or upstream-rejected explicit level, assert actionable guidance, no successful chat reply, and no saved analysis. Verify prior behavior for GPT-4.1 mini with Medium and other providers.
- AC4 / E4: Read a legacy file through the settings API and verify migration. Save each level independently and submit an invalid enum; verify rejection and no partial overwrite.

Main session owns the shared helper and final integration verification. Run and report E1–E4; fixtures may replace upstream discovery/generation, not the settings API or Mastra execution under test.
