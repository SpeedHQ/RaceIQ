# Codex usage UI plan

[Shared contract and CU-1–3 scenarios](codex-usage-contract.md) · [Backend plan](codex-usage-backend-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

| Task | Owner and write scope | Prerequisite | Acceptance |
| --- | --- | --- | --- |
| CUI-1 | Main session: `client/src/components/settings/ChatGptAccountSetup.tsx`, `client/messages/{locale}.json` | Agreed contract; backend implementation can proceed independently | CU-2, CU-3 |
| CUI-2 | Main session: Settings E2E under `playwright/tests/seeded/settings/` or existing local smoke harness, `UNRELEASED.md` | CUI-1 and CUB-1 for integration | CU-1, CU-2, CU-3 |

CUI-1: Extend `ChatGptAccountSetup` only where local account configuration is available. Keep the current account controls and usage link. Add a labeled Codex usage section with one shared Button to request or refresh the result via Hono RPC. Show the active local Codex account's quota, not the RaceIQ account's quota. Provide a polite loading/result announcement, clear old values on refresh, format percentages and reset dates in the active locale, and show a localized recovery instruction for each unavailable result. No polling, persistence, chart, or new visual system. Use existing text hierarchy, spacing, and button roles to match Settings (energy 1, rhythm 1, motion 1).

CUI-2: Use the existing Settings → AI Analysis navigation in `playwright/tests/seeded/settings/ai.spec.ts`. Exercise the real route, including keyboard refresh, supported and missing values, and error recovery; use an isolated direct-loopback app and the subprocess fixture described in the contract. Main session records browser evidence and runs typecheck after integration. Any live account check that cannot run remains unverified.
