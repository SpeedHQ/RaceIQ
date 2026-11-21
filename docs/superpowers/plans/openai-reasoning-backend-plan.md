# OpenAI reasoning levels backend plan

[Shared contract](openai-reasoning-contract.md)

| Task | Owner and scope | Prerequisite | Verification |
| --- | --- | --- | --- |
| BE1 | Main session: `shared/integrations/ai/openai-reasoning.ts`, `shared/package.json`, `server/runtime/config/settings.ts` | Contract | AC2–AC4, E2–E4 |
| BE2 | Main session: lap analysis, lap/compare chat and analysis, tune-chat request options and corresponding backend tests | BE1 | AC3, E3 |

Reuse settings schemas and response/error behavior. Validate the shared string enum, default to Medium, and migrate legacy booleans. Pass preferences to the OpenAI SDK through Mastra and let the SDK determine the Responses request and model compatibility. Surface actionable guidance when the SDK omits an explicit non-Medium level as unsupported or OpenAI rejects it; discard any resulting analysis or reply. Preserve Medium's existing SDK behavior and other provider paths.

Extend actual generation/stream tests at the upstream fetch boundary and exercise persisted settings via the existing API. Execute E3–E4, backend typecheck and existing provider regression tests and report outcomes. UI can proceed against the contract independently; real integration verification waits for both implementations.
