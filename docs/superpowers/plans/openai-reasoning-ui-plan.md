# OpenAI reasoning levels UI plan

[Shared contract](openai-reasoning-contract.md)

| Task | Owner and scope | Prerequisite | Verification |
| --- | --- | --- | --- |
| UI1 | Main session: `client/src/components/settings`, `client/src/stores/telemetry.ts`, locale catalogs | Contract | AC1–AC2, E1–E2 |
| UI2 | Main session: `playwright/tests/seeded/settings/ai.spec.ts` | UI1 and backend settings persistence | E1–E2 and settings API coverage for E4 |

Reuse native select styling and each section's autosave/baseline wiring. Localize the label and render the contract's seven values in English. Show the field for official OpenAI only. Keep one independent draft per feature and retain it through model changes. Do not duplicate SDK model compatibility checks in the UI; display errors through the existing analysis and chat surfaces. Backend and UI can implement independently against the contract.

Run the seeded settings Playwright scenarios and client typecheck. Record actual status, including any environment blockers; fixtures must not stand in for settings persistence.
