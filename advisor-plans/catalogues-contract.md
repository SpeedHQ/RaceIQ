# Tracks and cars catalogue extraction contract

Status: implemented and locally verified against CAT-01–08. The boundary follows the user's feature-package convention and existing application behavior. Tracks and cars were extracted first; dashboard extraction and broad selective-CI provisioning remain outside this implementation.

Pattern: [Feature packages](../docs/architecture/feature-packages.md). ADR: [Feature-owned E2E boundaries](../docs/adr/0015-e2e-aware-package-extraction.md).
Plans: [UI](catalogues-ui-plan.md), [server](catalogues-server-plan.md). Both plans use the criteria and real-system scenarios here.

## Ownership and interfaces

Create `@raceiq/tracks-catalogue` and `@raceiq/cars-catalogue` under correspondingly named `packages/` directories. Each is ONE workspace with top-level `ui/`, `server/`, `contracts/`, `test/e2e/`, one manifest and explicit `./ui`, `./server`, `./contracts` exports. No intermediate src directory, root barrel, compatibility forwarders or nested workspaces.

Tracks owns the track gallery, card/map/detail/debug/leaderboard/setup presentation and track route services currently in `client/src/components/TrackViewer.tsx`, `client/src/components/track/`, and `apps/backend/src/routes/tracks/`. Cars owns `client/src/components/cars/`, game-specific car catalogue views (ACC, AC Evo, F1, iRacing, LMU) and car catalogue/config services from `apps/backend/src/routes/car-routes.ts` plus their game-specific car-list endpoint implementations. Shared game metadata, capture processing and non-catalogue game handlers remain in their existing packages.

Application route wrappers and Hono composition remain thin host integration. Each feature exposes the existing public UI component names and typed Hono route groups through its public entries. Tracks registration preserves the current order in `apps/backend/src/routes/tracks/index.ts`; cars preserves existing game endpoint and resource precedence. Preserve `AppType` inference.

UI must not import client app implementation, server implementations or native/DB modules. Use typed feature host bindings, supplied by new feature-specific host adapters in `client/src/features/`, for existing controls, translations, RPC/auth, query hooks, units, navigation, settings/game context and shared rendering surfaces. The bindings must preserve existing operation signatures and error handling, not replace RPC with fetch or fabricate responses. Feature-specific binding declarations live in contracts; existing genuinely shared DTOs remain authoritative. Structural binding types must be precise, with no new any/unknown casts to silence errors. UI factories/providers may supply bindings without changing rendered output or introducing duplicate global services.

Backend may depend on existing backend-core/shared/metadata services but never import the backend app composition root or UI. Shared track helpers needed by other backend features must become a narrow shared leaf or public feature service without a dependency cycle; do not copy them. Preserve every HTTP/WS operation and existing native telemetry semantics.

Coordinator owns shared manifests/configuration/lockfile, client root and backend route composition, shared hook/test-owner reference integration, plan/status/docs/changelog and final verification. Feature implementers own disjoint source trees, feature packages and feature-specific host adapters. No checkpoint file (user declined). Workers do not build, test, lint, format, delegate, stage or commit.

## Existing application protocol remains authoritative

No new endpoint or payload design is introduced. Move existing implementations and exported schemas/types without semantic edits. Source authorities before relocation:

- Cars: `apps/backend/src/routes/car-routes.ts` and car-list operations in `routes/games/acc.ts`, `ac-evo.ts`, `f1-2025.ts`; UI interfaces in the existing game car views and `components/cars/types.ts`.
- Tracks: `apps/backend/src/routes/tracks/{catalog,segments,outline,leaderboard,geometry}-routes.ts` and `support.ts`; UI `components/track/types.ts` and shared geometry/semantic contracts.

Representative operations that must remain identical:

| Operation | Request semantics | Response/error semantics |
| --- | --- | --- |
| GET /api/cars | Required valid X-Game-Id; preserve game-specific catalogue dispatch and discovered-car merging. | Existing game-specific arrays, IDs, nullable specs/images and name ordering; missing/invalid header remains 400 with current message. Never fall back to Forza. |
| GET /api/cars/:carId | Existing validated string ID and game header. | Existing detail shape and current unavailable/not-found behavior. |
| GET /api/car-name/:carId; GET /api/resolve-names | Preserve optional validated game query and JSON identity-list validation. | Existing text/name maps and malformed-list errors; includes genuine track consumers. |
| GET/PUT /api/car-model-configs and existing dimensions/model endpoints | Preserve current schemas, auth/CSRF host middleware and persistence paths. | Existing config/dimension shapes, strict update validation and file behavior. |
| Game-specific car list operations | Preserve existing route prefixes, IDs, categories, classes and availability. | Exact current per-game response shapes, nullability and errors. |
| GET /api/tracks | Existing gameId query; preserve existing behavior for absent/unknown values rather than redesign it. | Existing list fields including id/name/location/country/variant, outline availability/source, lap counts and ordering. |
| GET /api/tracks/:trackId; GET /api/track-name/:trackId | Existing param/query validation and per-game resolution. | Existing metadata/text and 404 behavior. |
| Track assets, geometry, sectors, outlines, segments, calibration and leaderboard operations | Preserve all existing methods, route precedence, request schemas and game context. | Existing shapes, ordering, availability and mutation/error behavior. No broadened mutation permission. |

Example requests remain `GET /api/cars` with `X-Game-Id: iracing` and `GET /api/tracks?gameId=acc`. Field schemas stay in current authoritative definitions until moved; do not invent one normalized car DTO across games. Track navigation retains existing legacy query redirects and detail/tab URLs. Host auth/CSRF/CORS behavior remains unchanged.

## Acceptance criteria

| ID | Observable result |
| --- | --- |
| CAT-01 | Both feature packages own their complete requested UI/server/catalogue contracts and feature E2Es; application callers use public entries and obsolete implementation paths are removed. |
| CAT-02 | Every current game-specific car catalogue retains search/filter/sort/grid/table/detail/comparison/model-link behavior and exact API data semantics, including discovered cars and absent specs. |
| CAT-03 | Track gallery/detail retains search/sort/maps/availability, tabs, legacy redirects and supported lap/compare/setup/guide/debug flows; existing mutations and query behavior remain unchanged. |
| CAT-04 | UI/contracts import closure is browser-safe, no reverse app dependency or mixed entry barrel; a forbidden UI-to-server import is rejected by an actual boundary gate. |
| CAT-05 | Existing route composition, inferred RPC types, auth, configuration persistence, registration order and compiled-app startup remain valid. |
| CAT-06 | Full test discovery retains all existing test identities after path moves, no duplicated ownership, and both package E2E tasks exercise the actual complete compiled application. |
| CAT-07 | Feature impact inputs include UI/server/contracts/specs and genuine shared dependencies. Cars-only and tracks-only changes select their own E2Es plus actual consumers, not the other feature solely due to a full-app build. Unknown/shared changes remain conservative; residual broad CI limitations are reported rather than hidden. |
| CAT-08 | Relevant typechecks/lint/build, feature suites and real integrated E2Es pass with recorded outcomes; unavailable gates are explicitly unverified. No result-cache policy change or fabricated timing claim. |

## Edge cases and real-system E2E strategy

Integration owner extends/reuses `playwright/tests/seeded/catalog/{cars,tracks}.spec.ts` after relocation. Preserve assertions; specs may keep explicitly declared cross-feature journeys. Use existing seeded/fresh harness and committed fixture data, isolated DATA_DIR and ports, enabled supported game flags. Mocks/Storybook do not replace application integration.

| Scenario | Setup → action → expected observation | Criteria |
| --- | --- | --- |
| CAT-E01 cars | Existing seeded multi-game data → open each car route, run existing search/filter/view/detail/comparison actions → unchanged visible results and no browser errors. Include LMU smoke if not in current five-game suite. | CAT-01/02/05/08 |
| CAT-E02 car protocol | Real app/isolated DB → valid/missing/invalid game headers, known/unknown IDs, existing discovered metadata and nullable specs → unchanged HTTP statuses/data and no Forza leakage; existing model/config updates retain validation/persistence. | CAT-02/05/08 |
| CAT-E03 tracks | Existing committed fixtures → gallery search/no-match/reset/sort, card/detail/tab navigation, lap→compare→back, setup/guide capability, original query redirects → existing URLs/content/state, no browser errors. | CAT-01/03/05/08 |
| CAT-E04 track failures | Actual app with absent map/outline/curb assets, unknown IDs and existing route validation cases → current availability/404/error behavior; no invented geometry or changed permissions. Exercise existing debug/calibration mutation path where enabled. | CAT-03/05/08 |
| CAT-E05 discovery | Compare real Playwright list before/after → existing test identities retained exactly once; run both feature E2E task entry points against full compiled application. | CAT-01/06/08 |
| CAT-E06 boundary | Inject forbidden UI→server import in disposable isolated fixture/worktree → boundary command fails; remove it → production client builds and actual pages run without bundled DB/native/server initialization. | CAT-04/05/08 |
| CAT-E07 selection | Controlled cars UI/server/spec and tracks UI/server/spec changes through real Turbo impact CLI → owning task selected, independent feature not selected absent actual dependency. Shared platform/harness/metadata and missing SCM history retain every actual consumer/full fallback. Execute selected real E2Es; deliberate owned-test failure propagates nonzero. | CAT-06/07/08 |
| CAT-E08 composition | Start compiled app with fresh and seeded isolated state → shared auth/route registration and cross-feature catalogue→session/compare flows function; relevant root/feature typechecks and lint pass. | CAT-03/04/05/06/08 |

Record exact command, platform, selected task IDs, pass/fail and real API/UI observations. Baseline failures remain distinct; do not rerun user-reported failures solely to reconfirm them. Final integration is a completion dependency for both plans. No desktop/native control is authorized; use page-only browser automation and existing runnable E2E commands.

## Verification outcomes

Integration owner: coordinator. Platform: macOS arm64. The following evidence exercises the real application; fixtures and mocks did not replace UI/server integration.

| Scenarios / criteria | Execution and observed outcome |
| --- | --- |
| CAT-E01 / CAT-01/02/05/08 | `bunx turbo run test:e2e --filter=@raceiq/tracks-catalogue --filter=@raceiq/cars-catalogue` passed all five Turbo tasks. Cars passed six game cases plus seeded setup; tracks passed five feature cases plus seeded setup. The shared compiled application build ran once. |
| CAT-E02 / CAT-02/05/08 | Four real API regression files passed 21 tests and 860 assertions. Independent compiled-app requests returned 400 for missing/invalid car game headers, 200 for LMU, 404 for an unknown model config and 400 for an invalid config update. A valid model offset write/read returned 200; the exact value survived server restart. |
| CAT-E03 / CAT-01/03/05/08 | Compiled track cases passed gallery, sort, capability, lap/compare/back and disposable import/delete flows. Additional actual browser smoke passed ACC/LMU search, no-match/reset, detail/laps navigation and native slash-containing LMU URLs. The legacy `?track=5&tab=laps` URL redirected correctly. |
| CAT-E04 / CAT-03/05/08 | Unknown outline returned 404 with no geometry; unknown track rendered the existing not-found state without a canvas or page exception. The actual source app's debug UI submitted invalid 80/20 sector boundaries, received 400, retained editing/cancel controls and left before/after geometry identical. Existing capability cases retained unavailable-asset behavior. |
| CAT-E05 / CAT-01/06/08 | Real Playwright discovery loaded the original HEAD definitions and compared their titles with the relocated suites. All five original car and five original track cases remain exactly once in their owning projects; the only added catalogue case is LMU cars. Final full discovery succeeded with 231 tests and no temporary probes or baseline copies. |
| CAT-E06 / CAT-04/05/08 | Both actual package boundary gates passed. A temporary forbidden UI-to-server export made the real boundary CLI exit 1; removal restored the valid graph. Boundary fixtures passed six tests/eight assertions. The production browser build and real desktop/mobile pages rendered without server/native initialization errors. |
| CAT-E07 / CAT-06/07/08 | Thirteen controlled SCM scenarios passed through `turbo run e2e:impact test:e2e --affected --filter=@raceiq/*-catalogue --dry=json`, covering both features' UI/server/spec changes, shared consumers, no changes, invalid refs and valid shallow-history fallback. A temporary owned test emitted `CAT-E07 intentional owned-test failure`; Playwright, the package script and Turbo all exited 1. The sentinel was removed. |
| CAT-E08 / CAT-03/04/05/06/08 | Compiled fresh-install passed 17 tests, including auth/login/logout, WebSockets, sharing and onboarding/migration. Root typecheck and lint each passed 35 tasks; tooling passed eight tasks; shard validation assigned all 409 ordinary files exactly once. Two client regression files passed eight tests/24 assertions. |

Desktop/mobile cars and tracks screenshots were inspected; neither surface overflowed horizontally. There were no page exceptions in the independent browser smoke. Existing seeded historical-classification warnings are not evidence that those unrelated background jobs succeeded.

Durable local evidence lives under `.omp/evidence/`: `catalogue-impact.json`, `catalogue-discovery-summary.json`, complete `catalogue-discovery.json`, `catalogue-browser-api.json`, `catalogue-browser-edges.json`, `catalogue-probes.json`, four screenshots and the associated verification logs.

The standard dev harness timed out before startup during its unconditional translation compilation. Generated translations were independently validated and reused; the same debug probe passed against the actual backend and Vite entrypoints with isolated seeded state. Shared harness timeouts and production behavior were not changed to hide the failure.

No GitHub CI run or CI timing reduction is claimed. Full browser callers and the existing matrix still include both projects. Package-level selective execution is verified; broad selective job provisioning remains a separate rollout. E2E result caching is unchanged. Temporary probes/configuration/programs were removed; no commit or push was made.
