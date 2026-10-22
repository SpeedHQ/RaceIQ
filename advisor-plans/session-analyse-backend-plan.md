# Session Analyse backend implementation plan

Shared decisions and acceptance: [integration contract](session-analyse-contract.md). UI work: [UI plan](session-analyse-ui-plan.md).

## Scope and ownership

Backend implementation owns `packages/session-analyse/server/`, HTTP request schemas, review persistence query migration, app route mounting and exclusively owned route/query tests. Coordinator owns package manifests/TypeScript/Turbo, Playwright/CI and final integration. Shared DB exports required by the move remain backend-owned public platform services, not new DB instances. UI contracts and host are independently owned.

## Tasks

1. Move existing review-lap and review-line-spread handlers and their exact schemas into the feature; export a typed Hono factory receiving the existing corner resolver. Mount before parameterized lap routes; remove old handlers/schemas and migrate callers without forwarding shims. SA-1/4.
2. Move authoritative `getReviewLaps` implementation and focused persistence tests; reuse public shared DB/schema/meta/eligibility services. Preserve SQL filtering, ranking/tie-break, limit and serialization. Do not move shared capture decoding, AI, alignment, consistency algorithm or lifecycle. SA-1/4.
3. Split exclusively owned route assertions out of mixed lap-analysis tests; preserve unrelated assertions and full-suite isolation. Add real-app HTTP E2E boundary coverage where missing, using deterministic existing fixtures and no production mocks. SA-4/6.
4. Integrate real typed RPC registration and run final production entry-point scenarios with UI; coordinator updates manifests/configuration and executes gates. SA-1/4/5/6.

## Edge handling and verification

Contract E4 covers required/invalid inputs, limit boundaries, session precedence, ordering, missing sessions, foreign/missing/duplicate/oversized lap selections and empty/insufficient/no-trace consistency results. Preserve current Zod/body/status semantics and propagate unexpected failures through existing middleware. E1–E3 prove real UI calls reach moved handlers and persistence; E5 proves shared consumers remain intact; E6 proves server-only code stays outside browser and all tests retain one owner.

Coordinator executes existing/extended compiled-app browser and HTTP scenarios plus focused real-persistence integration checks, root affected compiler/lint/tests and boundary gates. Record execution and unresolved setup gaps in the shared contract. Backend completion requires SA-1/4/5/6 and production UI/backend evidence; isolated factory/mocked tests alone are not sufficient.
