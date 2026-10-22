# Sessions page UI extraction plan

Authority: [shared contract](sessions-page-contract.md); counterpart: [backend plan](sessions-page-backend-plan.md).

## Scope and tasks

1. Move `client/src/components/sessions/` implementation into `packages/sessions-page/ui/`, preserving behavior and styles. Keep genuinely shared badge/recap helpers with appropriate owners rather than introducing hidden provider requirements.
2. Define browser-safe host contracts in `packages/sessions-page/contracts/`; follow existing catalogue/replay provider convention. Inject shared controls, translated messages, game/router state, authenticated typed operations, shared import/cleanup/result components and query integrations through `client/src/features/sessions-page-host.tsx`. Do not import application implementations from the feature.
3. Move exclusively owned unit tests to package test ownership. Migrate public consumers and story/provider integration; remove obsolete paths and forwarding shims. Coordinator integrates shared consumer and configuration changes.
4. Coordinator relocates existing Sessions E2Es, preserving existing harness imports and assertions; registers one feature project and package test/impact tasks.

## Acceptance, edges and verification

Own SES-1/2/3, contribute SES-4/5 from the [shared acceptance matrix](sessions-page-contract.md#acceptance-and-e2e-strategy). Empty/no-match, nullable names/sectors/results, Mine/Others transitions, selection/filter changes, import cancellation/errors and responsive transitions retain current behavior via unchanged implementation and existing regressions. No fake production fallback.

Use shared matrix scenarios: isolated real compiled app/DB seeded Sessions interactions, persistence/import/export/cleanup, desktop/mobile visual inspection and Analyse navigation. Coordinator executes relocated E2Es, targeted consumer tests, client/story/package typechecks, boundaries, browser build and selection checks after integration; records outcomes in contract. UI work does not depend on server relocation; existing endpoints remain unchanged. Final completion depends on actual UI/server integration evidence, not mocks.

## Implementation outcome

UI extraction and consumer cutover are implemented. Sessions owns its actual page/table/toolbar/import orchestration and pure helpers; the client supplies the typed production host. Shared badge/recap implementations have one app owner, and UTC parsing has one frontend-pure owner. Owned unit/E2E cases moved with the feature; shared disposable browser fixtures retain their genuine shared harness owner.

The final complete Sessions E2E invocation passed, as did focused consumer tests, typing, boundaries, lint, browser-module auditing and independent desktop/mobile inspection. The strengthened real-import pagination scenario also passed. Exact results, the optional unavailable MoTeC fixture and failed broader full-mode gate are recorded in the [contract verification section](sessions-page-contract.md#implementation-and-recorded-verification). Full-repository acceptance is not claimed.
