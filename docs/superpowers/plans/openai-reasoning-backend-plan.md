# OpenAI reasoning levels backend plan

[Shared contract](openai-reasoning-contract.md)

| Task | Owner and scope | Prerequisite | Verification |
| --- | --- | --- | --- |
| BE1 | Main session: `shared/integrations/ai/openai-reasoning.ts`, `shared/package.json`, `server/runtime/config/settings.ts` | Contract | AC2–AC4, E2–E4 |
| BE2 | Main session: lap analysis, lap/compare chat and analysis, tune-chat request options and corresponding backend tests | BE1 | AC3, E3 |

Reuse the settings schemas and existing response/error behavior. Add booleans with backward-compatible defaults. Consume each preference at its existing reasoning-effort call site. Only override `medium` for official OpenAI models known to accept `none`. Keep required models and other providers on their prior path. Match common snapshot suffixes conservatively without guessing support for unknown models.

Extend actual generation/stream tests at the upstream fetch boundary and exercise persisted settings via the existing API. Execute E3–E4, backend typecheck and existing provider regression tests and report outcomes. UI can proceed against the contract independently; real integration verification waits for both implementations.
