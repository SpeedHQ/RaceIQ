# ChatGPT subscription provider: UI implementation plan

Status: proposed. [Shared contract](chatgpt-provider-contract.md) · [Backend plan](chatgpt-provider-backend-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

## Scope and ownership

Main session owns UI changes. Reuse `client/src/components/settings/AiSection.tsx`, `AiPickers.tsx`, `useAiSettings.ts`, `useAiModelData.ts`, `ai-state.ts`, existing section components, TanStack Query, Hono RPC, shared controls, and every supported locale in `client/messages/`. Add a local account control in the existing AI provider setup; don't add a settings page or duplicate account controls across features. Extend existing chat/analysis/tuning/profile errors only where needed to display the contract's actionable states. No new model transport or OAuth parsing in the browser.

| Task | Deliverable and ownership | Prerequisite | Acceptance |
| --- | --- | --- | --- |
| **UI-1** | Provider setup: API state query, approved Continue with ChatGPT action, pending/cancel, account picker, active state, reauthorization, sign-out, warning for unconfirmed revoke, link to ChatGPT usage settings. Own `AiSection.tsx`, existing provider setup component and a narrowly scoped account component/hook under `client/src/components/settings/`. | Contract agreed; typed fixtures allowed until backend integration. | CG-1/2, CG-E1/E2, CG-L1/L3. |
| **UI-2** | Extend shared provider/model picker and settings state for all four sections. Use account-scoped model discovery and operation capability metadata. Own settings sections, model hooks, provider state helpers, client DTO use and locale keys. | Shared contract and DTOs; no backend runtime dependency during implementation. | CG-1/5, CG-E1/E5. |
| **UI-3** | Surface safe provider failures and recovery in the affected existing AI surfaces; preserve existing cancellation, history/edit and tuning confirmation controls. Own only affected client feature consumers and message keys. | Contract error definitions; no backend runtime dependency during implementation. | CG-3/4/5, CG-E3/E4/E5. |

UI-1/2/3 can be developed independently of backend once contract/DTOs are agreed. Main session integrates and owns file overlap. Use real routes in production; fixtures are not runtime fallbacks.

## Behavior and failure handling

- One sign-in per local installation, shared by all settings sections. Use the [OpenAI sign-in label and usage guidance](https://developers.openai.com/siwc/ui-ux-guidelines) and existing controls. Open only the returned HTTPS authorization URL at the documented host; use an external browser link if the browser blocks a new window. Don't persist it. Poll account state only while pending; closing the sign-in window is recoverable via Cancel or timeout. Never show Connected until callback validation and persistence succeed. Changing settings before sign-in attempts finish does not enable the provider.
- Use existing provider and model selection semantics and only offered compatible models. Don't insert a hardcoded default, display an old model as valid after account switch, or submit silently on reconnect. Distinguish loading, empty catalog, stale selection, offline, ineligible runtime and sign-in required. Keep unsaved edits consistent with current settings behavior, leave unrelated saves and old providers untouched, and show failure without pretending it saved. No API-key input for this provider. Display consumption as ChatGPT plan usage with OpenAI account limits, not free/unlimited.
- Existing sections remain keyboard navigable, status announces changes, and account labels disambiguate registrations. Route in-app recovery via shared Button/router, external links only for sign-in and OpenAI account pages. Don't expose raw upstream errors, token hints or account IDs in error copy. Localize all new UI copy and preserve existing message/history rendering.

## Verification

Extend `playwright/tests/seeded/settings/ai.spec.ts` and use `playwright/tests/seeded/analyse/qwen-ai.spec.ts` and `playwright/tests/seeded/chats/streamed-setup.spec.ts` as route/browser patterns. Main session runs every mapped scenario in the contract, including packaged Windows live evidence. Observe all four persistence paths, local auth and account switch/revoke, browser keyboard/focus and error states, actual streamed and structured workflows, and no fallback call. UI validation does not substitute for backend or live verification. Record results after integration; none have run for this plan.
