# Provider reasoning backend plan

[Shared contract](provider-reasoning-contract.md). Status: draft for review. Main session owns shared files, implementation and final integration verification unless the user requests delegation.

| Task | Deliverable and acceptance | Write scope | Prerequisite | Verification |
| --- | --- | --- | --- | --- |
| PR-S1 | Shared capability matrix, resolver interface and enum; PR-AC1, PR-AC3 | `shared/integrations/ai/provider-reasoning.ts`, `shared/package.json` | Verified model/protocol mappings and agreed contract | PR-E1 and PR-E3 |
| PR-B1 | Sparse preference validation, persistence and API response; PR-AC2 | `server/runtime/config/settings.ts`, `apps/backend/src/routes/settings-routes.ts` | PR-S1 types | PR-E2 |
| PR-B2 | Provider-native request and error handling; PR-AC3, PR-AC4 | `apps/backend/src/ai/generate-lap-analysis.ts`, `apps/backend/src/mastra/model.ts`, `apps/backend/src/routes/laps/{chat-routes,comparison-routes}.ts`, `apps/backend/src/routes/tune-chat-routes.ts`, `server/ai/{providers,google-provider-options,openai-compatible-headers}.ts` where the affected paths require changes | PR-S1 resolver; PR-B1 settings interface | PR-E3 and PR-E4 |
| PR-B3 | Request and failure evidence across real workflows; PR-AC3, PR-AC4 | Relevant `apps/backend/test/ai/` tests and their upstream HTTP fixtures | PR-B2 for execution | PR-E3 and PR-E4 |

## PR-S1: Capability source

Before coding, verify installed SDK versions, provider documentation, actual transports, and supported model/endpoint combinations. Write the exact choices and wire values in the capability matrix; identify the default model for each affected entry point. Do not promise levels unavailable on the installed transport. If Claude’s current OpenAI-compatible API or another existing adapter cannot carry a documented setting, report the gap and the smallest proposed change before widening transport scope. Publish the matrix and resolver interface for UI and backend to use independently.

## PR-B1: Settings boundary

Implement storage defaults and request schemas from the contract. Merge per-provider updates against current settings inside the existing settings save path. Preserve OpenAI legacy migration and numeric Gemini budgets. Confirm neither an invalid request nor an omitted map can reset existing settings. Reuse existing auth and error responses.

## PR-B2: Execution

Resolve a preference for the actual provider/model and workflow at each callsite. Keep existing OpenAI request handling and build native provider options for verified new paths. In Gemini, emit a budget or a level, never both. Distinguish DeepSeek’s SDK path from the raw fetch path: preserve present defaults, enable thinking only for a supported explicit choice, and keep schema prompting and tool continuation intact. Do not put user preference into transport defaults used by Auto-tune and Driver Profile. Treat provider rejection, known SDK omission and unusable length-limited output as failures under the contract; preserve unrelated error behavior. Do not change model discovery.

## PR-B3: Verification

Extend existing generation tests in `apps/backend/test/ai/tools/generate-lap-analysis.test.ts`, route tests in `apps/backend/test/ai/chat/chat-route-context.test.ts`, and relevant comparison/setup/provider suites. Exercise real app handlers, settings and adapters, isolating settings per scenario and replacing only upstream HTTP. If a required workflow is not reachable through those suites, extend Playwright’s seeded runner to serve a controlled upstream HTTP fixture for that route. Verify the outbound request and resulting app state, including tool calls, structured output, streaming and failure/no-success assertions. Execute PR-E3 and PR-E4 and backend typing after implementation; record exact tests and observed outcomes. Final integration also requires PR-E1 and PR-E2 from the shared contract.
