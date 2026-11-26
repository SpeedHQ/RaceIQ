# Codex usage backend plan

[Shared contract and CU-1–3 scenarios](codex-usage-contract.md) · [UI plan](codex-usage-ui-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

| Task | Owner and write scope | Prerequisite | Acceptance |
| --- | --- | --- | --- |
| CUB-1 | Main session: `apps/backend/src/ai/codex-usage.ts`, `apps/backend/src/routes/{chatgpt-subscription-routes,index}.ts` | Agreed contract | CU-1, CU-2, CU-3 |
| CUB-2 | Main session: targeted route/protocol tests and integration | CUB-1; CUI-1 for browser evidence | CU-1, CU-2, CU-3 |

CUB-1: Mount a read-only operation under the existing authorized local account route. Enable the reader only with the existing local macOS opt-in in `chatgpt-subscription-runtime.ts`. Starting from `createChatGptSubscriptionRoutes` and its mount in `routes/index.ts`, bind the reader without calling the account service or introducing a new setting. Spawn the installed `codex app-server --listen stdio://` without a shell, with a minimal environment that allows the CLI to use its own authentication. Send `initialize`, `initialized`, `account/read` without forced refresh, and `account/rateLimits/read` for a managed ChatGPT account only. Match RPC IDs, bound bytes and total time, stop the subprocess on every outcome, and coalesce simultaneous reads so requests cannot multiply processes. Decode only the contract fields, never store quota, and do not forward raw responses. RaceIQ account selection and inference are out of scope.

CUB-2: Extend the existing account route guard test in `apps/backend/test/ai/chatgpt-subscription-routes.test.ts`; cover protocol failure in the isolated executable fixture. Run the shared actual-app scenarios, including the locally installed CLI, and record which variants ran. Do not use a fixture as proof of the live account.
