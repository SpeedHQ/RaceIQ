# OpenAI reasoning switches UI plan

[Shared contract](openai-reasoning-contract.md)

| Task | Owner and scope | Prerequisite | Verification |
| --- | --- | --- | --- |
| UI1 | Main session: `client/src/components/settings`, `client/src/stores/telemetry.ts`, locale catalogs | Contract; shared helper for final integration | AC1–AC2, E1–E2 |
| UI2 | Main session: `playwright/tests/seeded/settings/ai.spec.ts` | UI1 and backend settings persistence | E1–E2 and settings API coverage for E4 |

Reuse the existing `Switch` and each section's autosave/baseline wiring. Use localized labels and disabled-state explanation. Hide when capability is absent; show checked and disabled when reasoning is required. Keep one independent draft per feature and retain it through model changes. Use the existing layout with no new motion or effort controls. Backend and UI can implement independently after agreeing the contract.

Run the seeded settings Playwright scenarios and client typecheck. Record actual status, including any environment blockers; fixtures must not stand in for settings persistence.
