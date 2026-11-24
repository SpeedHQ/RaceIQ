# ChatGPT chat usage UI plan

[Shared contract](chatgpt-chat-usage-contract.md) owns the API, arithmetic and CU acceptance/scenario definitions.

| Task | Owner and write scope | Prerequisites | Acceptance |
| --- | --- | --- | --- |
| CU-U1 | Main session: `client/src/components/ai-chat/`, `client/messages/` | Agreed contract; use typed fixtures while backend work proceeds | CU-3; CU-E1/E2 |
| CU-U2 | Main session: `client/src/components/settings/`, client settings types, `client/messages/` | Agreed settings field and shared effort mapping | CU-4; CU-E3 |

Extend the existing footer without replacing context or token fields. Read persisted assistant metadata, query the typed pricing route through Hono RPC/TanStack Query, format USD without rounding positive usage to zero, and disclose price age. Keep the existing setting control and layout; show model default and supported values only. Localize new copy in every shipped locale. Main session runs applicable seeded Playwright scenarios after backend integration and records results or blockers. No redesign or changes to other provider controls.
