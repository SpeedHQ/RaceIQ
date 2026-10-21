# Plan 005: Extract dashboard UI ownership and clean client boundaries

Status: TODO / PROPOSED. Dashboard UI pilot priority P2 alongside backend pilot; other boundary cleanup P3. Effort M. Risk medium: losing type safety or capability semantics.
Planned at `4eef7739c`, 2026-10-21. No implementation or commit authorization.

Shared authority: [E2E extraction contract](002-e2e-extraction-contract.md). ADR: [decision](../docs/adr/0015-e2e-aware-package-extraction.md).
Counterparts: [CI/integration owner](003-e2e-selection-plan.md), [backend/shared declaration owner](004-e2e-backend-plan.md).

## Current state and decision

`client/src/lib/rpc.ts:1-2,27-29` uses `hc<AppType>` with inferred backend routes. Preserve this contract and authenticated fetch/CSRF behavior. Removing the backend manifest dependency without replacing real imports would make the graph inaccurate, not improve architecture.

`client/src/lib/wireframe-capabilities.ts:1` imports `iracingLiveCapabilities` from the server game package. Browser-safe capability data belongs at the existing iRacing metadata boundary, not inside the native/runtime game workspace.

Driver components/hooks and Storybook fixtures import driver DTO types from `@raceiq/backend-core/driver-profile/detectors`, `.../trend` and `@raceiq/backend/driver-profile/fingerprint`; `client/src/hooks/recording-storage.ts:2` imports a relocation status type from a backend implementation. These declarations can be neutral shared types, but moving them does not remove the inferred RPC dependency or make all backend changes browser-irrelevant.

`client/package.json:62-96` also declares tooling and several game dependencies. Remove only proven-unused or migrated edges after references are checked; dev dependencies still participate in the workspace graph. Existing `@raceiq/frontend-pure` already contains speed, temperature, lap-time parsing and iRacing sorting helpers; do not recreate it.

## Scope and parallel ownership

Own `client/src/lib/wireframe-capabilities.ts`, its capability consumers/tests, driver-profile components/hooks/stories using relocated DTOs, `client/src/hooks/recording-storage.ts`, client package/TypeScript declarations, and browser-safe iRacing capability declarations under `packages/game-iracing-metadata/`. Backend owner owns shared DTO declarations and server callers. Agree exact exports through the shared contract before changing imports; client fixtures can use the unchanged type shapes meanwhile.

Do not change route/response fields, auth/CSRF, translations, UI design, scene behavior, native telemetry mapping, capability meaning or test-result caching. UI scope is `packages/dashboard/ui/` within the SAME feature workspace as server, contracts and E2Es. Retain thin host route wrappers. Backend owner controls `server/` and agreed `contracts/` declarations; CI owner controls the feature manifest/exports/configuration and `test/e2e/`. Do not create separate dashboard UI/server/test workspaces or relocate the whole client for cosmetic uniformity.

## Tasks

### U0. Extract the dashboard UI pilot

Move Home/period/recap presentation and hooks from `client/src/components/home/`, `client/src/hooks/dashboard.ts` and dashboard-specific car queries into `packages/dashboard/ui/`, exposed as `@raceiq/dashboard/ui`. The same `@raceiq/dashboard` package owns server implementation, feature contracts and E2Es. Preserve unchanged HTTP/WS behavior. Keep portable dashboards, global navigation/auth, session detail/Analyse and unrelated features outside this feature; Brand/shared controls remain shared where genuinely reused.

Retain static thin TanStack route wrappers, not a second router. Replace `@/` imports into the app with explicit typed host bindings for existing authenticated Hono RPC, settings/game context, navigation, translations and shared controls. Start with existing Home props/shared DTOs; do not duplicate API shapes. Feature UI imports its `./contracts` entry, never backend implementation or a mixed feature root barrel. Shared primitives belong in narrow independent packages or explicit host bindings, never a reverse dashboard → client dependency. Enforce transitive UI-to-backend restrictions with scoped typechecking/import rules and verify server-only modules are absent from the production browser bundle.

Keep host bindings/route wrappers in client, feature implementations inside one package and tests with that same feature owner. CI owner moves Home specs from `playwright/tests/seeded/landing/landing.spec.ts` to `packages/dashboard/test/e2e/` and updates discovery/imports. Preserve Home → Sessions → Analyse as a declared cross-feature consumer rather than narrowing its assertions. Do not mistake portable `seeded/dash/` specs for Home coverage.

Verify AC-08/11/12 through E09/E10 with the real compiled backend/API/SQLite/WS. Assert global/per-game period results, mine-only cards, recap links, no-session/coverage states, error recovery and live invalidation. Compare full discovery before/after; no omitted or duplicated specs. Dashboard-only UI/backend/spec changes select dashboard + app smoke + genuine dependent journeys, not unrelated tuning suites. Shared router/auth/locale changes remain conservative.

UI/backend pilot work proceeds in parallel after contract approval; contract-conforming fixtures may support development, never replace final production integration. Reconcile active plan 001 edits before relocating affected files.


### U1. Move browser-safe capabilities to metadata

Trace all `iracingLiveCapabilities` references through the language server. Move the authoritative browser-safe value/type to existing `@raceiq/game-iracing-metadata`; update native/game/client consumers statically. Verify its imports are browser-safe and metadata remains independent of game runtime/backend/client. Remove the obsolete export/path instead of retaining a second source or shim. If it depends on runtime code, extract the data declaration, not runtime initialization.

Verify: affected game/metadata/client typechecks; existing wireframe capability behavior remains identical; run contract E08 against compiled live/seeded scene UI consuming the actual capability. Unsupported channels/features remain unavailable, never renamed/aliased into supported ones.

### U2. Consume shared DTO declarations without losing RPC typing

After backend owner supplies authoritative exports, migrate every client/stories/fixture DTO import. Keep real request/response semantics and nullable/optional fields unchanged. Preserve `hc<AppType>` and authentication logic. Do not generate handwritten duplicate endpoints, use unsafe type assertions, replace RPC with raw fetch, or suppress compiler checks to remove a dependency.

Verify: client and Storybook typechecks plus E08 driver/storage browser paths through actual API responses and reconnect/status transitions where applicable. Include representative null/empty driver data and storage idle/running/error states from the existing contracts, without introducing new behavior. Static-only DTO movement still requires real consumer smoke to detect bundle/import issues.

### U3. Clean manifest edges and coordinate input separation

Review references before dropping each client dependency. Keep backend route type dependencies while still imported. Remove server game dependency only when all runtime/type imports are migrated; no invented graph exclusions. Supply CI owner the browser runtime, locale, generated asset, config and test-support inputs needed for accurate selection. Keep actual typecheck graph broader if required.

Do not make recording replay depend on client compilation or localization unless its test actually consumes client code. The frontend-contract-tests owner has real client/game/application dependencies and remains a distinct consumer; do not pretend it is a pure parser test.

Verify: E08 UI and locale mutations select browser E2E but no game recording E2E solely via localization; E05 shared semantic changes still select all actual consumers. Run `bun run typecheck`, `bun run typecheck:storybook`, `bun run lint` and existing compiled browser integration after edits settle.

## Acceptance and end-to-end scenarios

Owned AC-09/11/12 and client portion of AC-08; shared AC-03/05/07/10. [Contract E08/E09/E10](002-e2e-extraction-contract.md#edge-handling-and-shared-end-to-end-scenarios) is authoritative for selection plus actual compiled client/backend integration. Coordinate E03/E05/E07 with the integration owner, do not replace them with Storybook/mock-only proof.

| Edge | Expected handling | Evidence |
| --- | --- | --- |
| Missing/unsupported native channel | Existing feature remains unavailable; no fallback telemetry semantics. | AC-08/09, E08 actual scene state. |
| Null/empty driver profile, idle/running/failed relocation | Existing shapes/status rendering preserved; no frontend-only fabricated values. | AC-08, E08 real API/browser states. |
| Backend route type-only change | Typechecking still sees the changed authoritative contract; browser skipping only if runtime closure proves no impact. | AC-05/09, E05/E08 selection and compiler evidence. |
| Locale/generated runtime asset change | Browser remains selected; game recording owners do not run solely due to unrelated localization. | AC-09, E08. |
| Genuine shared telemetry contract change | Every consuming replay/application/browser gate selected; no attempt to meet an arbitrary test-count target. | AC-05/07, E05/E07. |

Commands after implementation: `bun run typecheck`, `bun run typecheck:storybook`, `bun run lint`, `bun run build`, `bun run test:e2e`. Reuse relevant existing browser specs; use page-only browser smoke for capability/driver/storage consumers if existing specs do not exercise them. Record exact spec/command, API/WS observations, visible state and outcome with the integration owner. New selector cases run via the CI plan's tooling harness. No tests or builds are run for this planning-only request.

## Deferred, with reason

- Roll out further vertical feature packages after dashboard E09/E10 passes: tuning/setup next, then sessions/import; live telemetry and Analyse/Compare later because shared state and cross-feature processing make their boundaries riskier. Each new feature gets UI/backend/E2E owners and an explicit shared contract; do not mechanically create packages per page.
- Separate `@raceiq/api-contracts`: current Hono inferred route type is authoritative. A new declarations build/schema generator adds maintenance and drift risk; no such system is needed to gate docs-only E2E runs. Revisit only if typecheck fanout is independently measured as a bottleneck.
- Generic component/design-system extraction and relocating the app: no demonstrated E2E scheduling benefit.

Stop if a type move changes API shape, capability values, RPC inference or actual runtime bundling. Report the exact import boundary rather than weakening types or deleting a necessary manifest dependency. Mark DONE only after integrated E08/E09/E10 and shared E05/E07 evidence passes.
