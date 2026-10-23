# Online extraction UI plan

Contract: [shared boundary, ON-01–06 and ON-E01–05](online-extraction-contract.md). Parallel backend plan: [backend](online-extraction-backend-plan.md).

## Scope and tasks

Own `packages/online/ui/`, UI host-binding declarations, `client/src/features/online-host.tsx`, exclusively Online components/hooks/cache/validation and consumers. Move existing Online settings, onboarding, driver binding, uploads/history, summary and Community/replay UI without changing output. Keep shared app controls, navigation, translations and typed RPC in host bindings. Preserve React Query keys, provider lifetime, stale-account/cache/privacy fences and shared cross-feature consumers.

1. Define precise host bindings from existing signatures; use current catalogue provider convention.
2. Relocate feature implementation and frontend-owned regression tests; update every production/story/test caller; remove old implementations.
3. Integrate provider at the existing app composition point. Do not create duplicate state or compatibility forwarding modules.
4. Report required manifest dependencies, public exports and test-registration changes to the integration owner.

## Acceptance and edge handling

ON-01/02/03: same UI and consumer types through the feature public entry; no app import from feature. Preserve private/signed-out/loading/unavailable, expired-candidate, stale epoch/revision, queue pagination and replay errors by relocating the current behavior, not rewriting it. These cases map to ON-E01/02; browser safety maps to ON-E04. ON-05 maps to ON-E05 discovery/selection.

## Verification and completion

Integration owner runs ON-E01–05 after both slices settle, including actual full-app browser coverage, production browser build and root typecheck. Worker skips tests/build/lint/formatters. Completion depends on shared recorded E2E results, not fixtures alone. No checkpoint, commits or desktop control.

ON-E02 uses the shared isolated external-provider setup owned by the integration/test slice. It must render the real worker-backed connected controls and preserve sharing readback, sign-out, desktop/mobile history, and relocated onboarding checked/focus styles. UI work remains independent of this test-only prerequisite; production UI never uses fixture fallbacks.

Final integration: scoped UI acceptance passes through the five owned real-app Online scenarios, catalogue consumers and inspected desktop/mobile captures. See the shared contract's [executed evidence and limits](online-extraction-contract.md#executed-evidence). Existing broader fresh-install failures remain explicit; they are not passing proof. No production fixture fallback remains.

