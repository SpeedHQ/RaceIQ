# Provider reasoning UI plan

[Shared contract](provider-reasoning-contract.md). Status: draft for review. Main session owns implementation and verification unless the user requests delegation.

| Task | Deliverable and acceptance | Write scope | Prerequisite | Verification |
| --- | --- | --- | --- | --- |
| PR-UI1 | Display and persist the selected workflow/model’s supported controls; PR-AC1, PR-AC2 | `client/src/components/settings/{AiAnalysisSection,AiChatSection,OpenAiReasoningLevel}.tsx`, `client/src/components/settings/{ai-state,useAiSettings}.ts`, existing client settings RPC types if needed, and `client/messages/*.json` for new labels | Agreed contract and the shared capability interface from PR-S1; can use contract-conforming fixtures until PR-B1 and PR-B2 are ready | PR-E1 and PR-E2 |
| PR-UI2 | Cover options, persistence, switching and save feedback; PR-AC1, PR-AC2 | `playwright/tests/seeded/settings/ai.spec.ts` and its scoped settings fixtures | PR-UI1 for final execution; fixture authoring can start earlier | PR-E1 and PR-E2 against actual app and settings routes |

## PR-UI1: Controls and settings state

Reuse the `SearchSelect` pattern in `OpenAiReasoningLevel` for named choices. Keep OpenAI’s existing option labels, `Medium ⭐`, and saved values. For Gemini budget mode, keep the existing control and settings fields. Resolve capabilities from the chosen provider, model and endpoint; show no control for unsupported combinations. Use the same label and keyboard behavior in both sections, with their existing independent save status and feedback.

Initialize preferences from existing Settings data. Send only the changed workflow/provider entry on save and retain the current latest-save handling in `useAiSettings`. Display Default for a stored value that is unavailable on the active model, without treating that display value as a changed preference. Restore the stored selection when a supported model returns. No changes to model discovery, Auto-tune, Driver Profile or shared selector behavior.

## PR-UI2: Verification

Extend the existing independent reasoning persistence test in `playwright/tests/seeded/settings/ai.spec.ts` for PR-E1 and PR-E2. Use upstream discovery fixtures only to supply deterministic model IDs; GET and PUT use the real API. Cover keyboard selection, reload, provider/model changes, legacy state, and error feedback. Run `E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test --config=playwright/playwright.config.ts --project=seeded-e2e --no-deps --workers=1 playwright/tests/seeded/settings/ai.spec.ts` from the repo root and run `bun check --build tsconfig.json` from `client`. Report observed outcomes; final acceptance also depends on PR-E3 and PR-E4 from the shared contract.
