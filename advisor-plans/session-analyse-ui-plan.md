# Session Analyse UI implementation plan

Shared decisions and acceptance: [integration contract](session-analyse-contract.md). Backend work: [backend plan](session-analyse-backend-plan.md).

## Scope and ownership

UI implementation owns `packages/session-analyse/ui/`, UI/message/search contracts, `client/src/features/session-analyse-host.tsx`, moved UI consumers/helpers and exclusive UI unit coverage. Coordinator owns package manifests/TypeScript/Turbo, app root composition, styles and Playwright/CI integration. Backend owns server and HTTP schema files. Shared contract agreement is prerequisite; implementation then proceeds independently, with coordinator owning final integration.

## Tasks

1. Move actual `AnalyseRoute` selection validation/error UI, dashboard, selection dialog, overview and session helper implementation; move/rename resolved page to `SessionAnalysePage`. Keep application route shells thin; use a typed host slot for the existing independent `LapAnalyse` renderer. Migrate all runtime/story/test consumers to public exports; remove old paths. SA-1/2.
2. Define a narrow typed host using existing controls/services and typed RPC. Feature owns page/selection/query orchestration, including legacy session resolution, loading/error/empty transitions and telemetry reuse. Preserve dashboard consumption by experiments. SA-2/3.
3. Extract genuinely shared semantic sample types/conversion to `analysis-core`, numeric/identity parsing to `frontend-pure` where required; migrate every caller without aliases or reverse imports. Public feature search contracts preserve current parser behavior. SA-1/2/5.
4. Move focused helper assertions into the correct feature/shared owner, preserving independent shared live/replay coverage. Coordinator integrates manifests/style/provider/project registration. SA-1/5/6.

## Edge handling and verification

Use contract E1 for both entry URLs, tab/sector/detail transitions and aligned telemetry reuse; E2 for dialog cancel/apply, primary selection and reload; E3 for invalid/empty/missing selection and session errors; E5 for legacy/single-lap/experiment consumers. Preserve existing behavior rather than introducing new fallbacks. Contract E6 validates compiler, transitive browser boundary, production module exclusion and ownership/selection.

Coordinator reuses and extends existing compiled-app E2Es, then executes E1–E3/E5/E6 against the real backend. Isolated mocks may help development but cannot establish completion. Record exact outcomes and blockers in the shared contract; no unexecuted scenario counts as passing. UI completion depends on production UI/backend integration and SA-1/2/3/5/6 evidence, not only typechecks.
