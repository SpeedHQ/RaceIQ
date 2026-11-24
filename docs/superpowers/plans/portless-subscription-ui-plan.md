# Portless subscription UI plan

[Contract and PL-1–3 verification](portless-subscription-contract.md) · [Backend plan](portless-subscription-backend-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

| Task | Scope and owner | Prerequisite | Acceptance |
| --- | --- | --- | --- |
| PLU-1 | Main session: `ChatGptAccountSetup.tsx`, obsolete locale keys, `UNRELEASED.md` | Agreed contract; independent of backend | PL-1, PL-2 |
| PLU-2 | Main session: reuse AI Settings navigation in browser smoke | PLU-1 and backend integration | PL-1, PL-3 |

PLU-1: Remove the Portless-specific blocked branch and obsolete direct-sign-in guidance. Render the existing account and Codex controls based on the same server availability state for both local paths; preserve the layout, link, pending state, and OAuth handling. Do not show unavailable controls to unauthorized callers. Update the release note to reflect local development access without requiring a direct URL.

PLU-2: At the actual Portless URL from `bun dev`, follow the seeded Settings → AI Analysis navigation, start and cancel an OAuth attempt, check live Codex quota, and confirm unavailable states retain existing behavior. Main session owns browser verification and records any live sign-in completion gap.
