# ChatGPT chat usage backend plan

[Shared contract](chatgpt-chat-usage-contract.md) owns the API, arithmetic and CU acceptance/scenario definitions.

| Task | Owner and write scope | Prerequisites | Acceptance |
| --- | --- | --- | --- |
| CU-B1 | Main session: `apps/backend/src/ai/` pricing module, existing settings routes, shared usage types | Agreed route contract | CU-2; CU-E2 |
| CU-B2 | Main session: subscription stream/adapter/runtime, lap/comparison/experiment chat routes, `server/ai/agent-stream.ts` | Agreed usage shape | CU-1; CU-E1 |
| CU-B3 | Main session: shared effort capabilities, `server/runtime/config/settings.ts`, subscription model/runtime | Agreed setting contract | CU-4; CU-E3 |

Use the public `https://models.dev/api.json` runtime catalog; validate only OpenAI Standard rates and supported context tier data. Fail closed on missing models and malformed pricing, without exposing credentials. Capture request usage at the existing `response.completed` guard and persist through the existing assistant message metadata path. Resolve effort at binding time and permit only its sanitized wire field. Distinguish default from unsupported saved values without mutating settings. Main session owns shared types and all integration verification. Add focused cache/wire tests and execute shared Playwright scenarios after UI integration. No new database migration or billing integration.
