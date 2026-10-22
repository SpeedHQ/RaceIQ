# Session Analyse extraction contract

Implementation: [UI plan](session-analyse-ui-plan.md), [backend plan](session-analyse-backend-plan.md). Follow [feature package architecture](../docs/architecture/feature-packages.md).

## Agreed ownership and integration boundary

Create `@raceiq/session-analyse` with explicit `/ui`, `/server`, `/contracts` exports, no root/wildcard barrel. Preserve recording DTOs and algorithms in their authoritative shared packages.

The feature owns `AnalyseRoute` and its selection validation/error UI, session review dashboard, lap selection, overview/context/tire helpers, resolved session page, review-lap persistence query, review HTTP operations and their exclusive tests. Application route files remain thin parameter/game composition. Move the current page orchestration into `SessionAnalysePage`; its track/car parameters resolve legacy links into sessions rather than introducing a new group-review product. Existing single-lap rendering is supplied through a typed host `LapAnalyse` component slot. Experiment review and single-lap analysis consume the public dashboard without copying it.

UI uses a typed `SessionAnalyseHost` with existing shared controls, query/RPC services, routing/game context, translations, units and genuinely shared tune/track rendering. The feature owns its view/selection/query orchestration; do not replace it with a host-rendered whole page. Keep typed Hono RPC. No raw-fetch replacement, unsafe casts, fake production fallback, reverse client import or compatibility re-export.

Shared semantic sample types, aligned-trace conversion and wheel access move to an explicit `analysis-core` entry; client live/replay adapters consume that authoritative implementation. Shared numeric/identity URL primitives move to an explicit `frontend-pure` entry if required. Analyse search validation and its tab vocabulary are public feature contracts; migrate all callers, including contract tests. Existing shared DTOs remain authoritative.

Server exports `createSessionAnalyseRoutes(resolveLapCorners)` and the real review persistence query. The host supplies its existing corner resolver. Mount the factory before parameterized lap routes, preserving existing application auth/origin/CSRF middleware and inferred RPC types. Shared DB connections/schema/migrations, lap reads/capture decoding, alignment/cache, consistency algorithm, AI, notifications and lifecycle stay authoritative.

### Existing HTTP contract

- `GET /api/laps/review`: required `gameId: GameId`; optional positive integer `sessionId`; optional nonempty `trackId` and `carId`; integer `limit` defaults to 5, range 1–20. Require session ID or both track/car IDs. Session filter takes precedence when supplied. Return `LapMeta[]` from the authoritative shared DTO. Preserve valid pace-lap/positive-time/raw-capture filtering, fastest-first ordering with descending ID tie-break, SQL limiting and missing-session empty array. No pagination token or mutation.
- `GET /api/laps/review-line-spread`: required `gameId`, positive integer `sessionId`, comma-separated `lapIds` containing 1–5 unique positive integers. Every lap must exist and belong to that game/session; otherwise 400 `{ "error": "Selected laps must belong to session." }`. Preserve caller lap ordering. Only traces with at least 30 telemetry samples participate. Return the existing compact consistency DTO (without `lapLines`); no usable telemetry or trace yields existing empty arrays/zero scores, with usable `lapCount` retained. Shared consistency types/algorithm remain authoritative.
- Zod-invalid inputs retain existing 400 validation responses. Unexpected failures propagate through existing app error handling. No authentication change.
- Example: `/api/laps/review?gameId=acc&sessionId=42&limit=5`; `/api/laps/review-line-spread?gameId=acc&sessionId=42&lapIds=101,102`.

### URL/state contract

Keep `/$gameid/sessions/analyse?session=ID` and `/$gameid/sessions/$sessionId/analyse`. Preserve `AnalyseSearch` fields and validation, including legacy `trackTab`, canonical string identities, comparison `laps` and `primary`, and existing single-lap dispatch. Session IDs must be positive; session selection cannot mix track/car/lap selection. Comparison selection has 1–5 unique IDs, primary belongs to selection, and all IDs belong to selected session. Preserve URL canonicalization, back/replay navigation, default evaluation selection, dialog cancel/apply, invalid/excluded lap visibility, and loading/error/empty states.

## Observable acceptance criteria

- SA-1: Real session review implementation and exclusive suites live in the feature; every consumer uses public entries, with no obsolete implementation paths or dependency cycles.
- SA-2: Both session URLs, legacy track/car resolution and single-lap/experiment consumers preserve navigation, selection and validation.
- SA-3: Overview, sector and Analyse/track tabs, selection dialog, primary selection and telemetry detail interactions preserve output and query reuse; no additional semantic-telemetry fetches.
- SA-4: Review APIs preserve validation, ordering/filtering/limit, session isolation and consistency fallback/error behavior against real persistence.
- SA-5: Production browser excludes server/DB/native implementations; scoped compiler and transitive boundary gates pass and an injected forbidden import fails nonzero.
- SA-6: Full browser discovery preserves every existing case exactly once after ownership changes; feature scripts/CI/full mode include the new project. Controlled UI/server/spec/host/shared/unrelated/missing-history selection scenarios match actual dependencies and selected failing gates remain nonzero.

## Edge cases and E2E strategy

Reuse existing compiled-app Playwright setup, seed helpers and tests. Move session-owned `group-review.spec.ts` rather than copy it; retain cross-feature landing, lap replay and experiment coverage with original owners. Extend owned tests only for missing consumer-visible boundary cases.

| Scenario | Setup → action → observable outcome | Criteria |
| --- | --- | --- |
| E1 Session review | Real ACC seed → open both URL forms, switch Overview/sector/Analyse, drag detail range → expected views, same base lap set, bounded detail request and no semantic request/browser errors. | SA-1/2/3/4 |
| E2 Selection | Seeded multi-lap session → open/cancel/apply dialog, choose primary, reload → preserved valid selection/URL; cancel leaves state unchanged; replay/back navigation remains correct. | SA-2/3 |
| E3 Invalid/empty state | Existing AC Evo invalid session, missing session, malformed/mixed/duplicate/oversized/out-of-session selections → existing alert or empty state; no misleading analysis or cross-session data. | SA-2/3/4 |
| E4 API boundaries | Real application HTTP and controlled isolated DB fixtures → valid, missing/invalid game/session/identity/limit/ID inputs and cross-session IDs → preserved status/body/order/limit/filter and consistency output. Exercise zero/insufficient telemetry and no-trace fallback through real server entry and persistence; record any unavailable setup explicitly. | SA-4 |
| E5 Shared consumers | Existing lap-header return, legacy links, experiment review and cross-feature navigation scenarios → public dashboard renders, feature remains reachable and shared consumer behavior stays intact. | SA-1/2/3 |
| E6 Ownership/build | Compare before/after discovery; compiled production build module audit; actual selected Turbo gates with isolated source edits and missing history → no lost/duplicate tests, no browser server imports, correct selection and nonzero negative gates. | SA-5/6 |

Coordinator owns manifest/config/shared artifacts, final integration and evidence under `.omp/evidence/session-analyse/`; UI and backend implementations may proceed in parallel against this contract. No checkpoint. Completion requires recorded real integration execution, affected type/lint/unit/integration gates, selected feature E2Es and full-mode results. Failures outside the feature must be reported, not represented as passing or silently repaired.

## Implemented ownership and executed verification

The implementation is in `packages/session-analyse/`. Application route shells import the public `AnalyseRoute` and search validator; `client/src/features/session-analyse-host.tsx` supplies the existing shared renderers, controls and typed RPC services. The feature owns both review query hooks and their unchanged cache keys. Backend lap-route composition mounts `createSessionAnalyseRoutes(resolveLapCorners)` before parameterized lap routes. The review SQL implementation and its tests moved out of backend-core; shared DB, capture, alignment, consistency and AI services remain authoritative.

Shared numeric/identity parsing now lives at `@raceiq/frontend-pure/route-search`; semantic sample types/conversion and compact consistency DTOs live in explicit `analysis-core` entries. Every discovered client, experiment, replay, story and contract-test consumer was migrated without compatibility exports. Existing public exports in all three modified foundation manifests were checked against the starting commit and retained.

Evidence below is local workspace evidence under `.omp/evidence/session-analyse/`; these ignored logs and screenshots are not published repository artifacts.

| Criteria/scenarios | Executed evidence | Outcome |
| --- | --- | --- |
| SA-1/2/3/4; E1–E4 | `RACEIQ_FEATURE_F1_EXPERIMENTS=true RACEIQ_FEATURE_IRACING_ADAPTER=true bunx turbo run test:e2e --filter=@raceiq/session-analyse` against the real compiled application. [Feature E2E log](../.omp/evidence/session-analyse/feature-e2e.log). | 9 passed, including shared setup and all 8 feature cases. Both entry URLs, overview/sector/Analyse/detail interactions, base telemetry reuse, selection cancel/apply/reload, primary selection, malformed/empty/missing states and HTTP validation/session isolation passed. |
| SA-1/4; E4 | Feature unit/integration suites with real DB/cache and production route factory. [Feature test log](../.omp/evidence/session-analyse/feature-tests.log). | 2 unit and 3 integration tests passed. SQL eligibility, missing-capture exclusion, fastest-first ranking with descending-ID ties and default limit were preserved. |
| SA-4; E4 | Throwaway real HTTP server using the actual backend application route entry, real isolated DB/cache and existing app corner resolver; no mocked server integration. [HTTP smoke](../.omp/evidence/session-analyse/real-http-smoke.log). | Empty telemetry, 29-sample exclusion and non-resampleable 30-sample fallback returned exact compact bodies and usable lap counts. Existing foreign-origin middleware still rejected requests with 403. Temporary harness removed. |
| SA-1/2/5; E5/E6 | `bun run typecheck --continue`, `bun run lint`, `bun run test:unit`, `bun run test:tooling`; additional frontend-pure/analysis-core and migrated consumer regressions. [Final affected gates](../.omp/evidence/session-analyse/final-gates.log), [shared tests](../.omp/evidence/session-analyse/shared-tests.log), [aligned conversion and lint](../.omp/evidence/session-analyse/converter-and-lint.log). | All affected type/lint gates passed across 39 workspaces; affected unit/tooling tasks passed. Focused shared suites passed 24 frontend-pure and 221 analysis-core tests; three migrated client/backend consumer files passed 24 tests, with aligned telemetry fidelity checked separately. |
| SA-2/3; E1/E2/E5 | Independent compiled-app inspection at 1440×1000 and 390×844, using the existing isolated seeded launcher. [Browser smoke](../.omp/evidence/session-analyse/browser-smoke.json), [desktop overview](../.omp/evidence/session-analyse/analyse-desktop.png), [desktop Analyse view](../.omp/evidence/session-analyse/analyse-track-desktop.png), [mobile](../.omp/evidence/session-analyse/analyse-mobile.png), [mobile dialog](../.omp/evidence/session-analyse/analyse-dialog-mobile.png). | Loaded maps, ranges, issues and track telemetry rendered; no horizontal page overflow or browser errors. Mobile dialog controls had explicit/implicit labels, and Escape dismissed it. |
| SA-5; E6 | Production Vite build with an emitted-module audit. [Module evidence](../.omp/evidence/session-analyse/browser-modules.json). | 4,758 emitted modules included 13 feature modules, with no backend app, feature server, DB or native implementation leaks. Temporary audit script removed. |
| SA-6; E6 | Before/after full discovery, ordinary suite ownership and CI project checks. [Discovery comparison](../.omp/evidence/session-analyse/discovery-summary.json), [shared export preservation](../.omp/evidence/session-analyse/shared-export-preservation.json). | 279 existing browser cases retained exactly once; 282 after three meaningful new cases, including 8 feature-owned cases. All 431 ordinary test files assigned exactly once. All seven seeded CI shards and official full/seeded runners include `session-analyse`; record-demo remains outside the ordinary full-mode run by existing design. |
| SA-5/6; E6 | Ten isolated cases using current manifests/configuration and the real Turbo CLI. [Impact summary](../.omp/evidence/session-analyse/impact-summary.json), [selected forbidden gate](../.omp/evidence/session-analyse/selected-gate-failure.log). | UI/server/spec/host select this feature; unrelated Cars excludes it; shared helper/harness selects the actual five-feature closure; unchanged history selects none. Missing history and a selected forbidden UI-to-server import fail nonzero. Shared dependency selection is conservative; no CI savings are claimed. |

The separate Playwright harness/specification compiler gate, `bun check --project playwright/tsconfig.json`, also passed with no type errors in 201 files; this workspace does not define a root Turbo `typecheck` script.

An AST comparison against the starting commit also confirmed that all seven moved SQL, URL-parser and semantic-conversion function implementations are unchanged apart from formatting/comments. [Implementation preservation](../.omp/evidence/session-analyse/implementation-preservation.json).

### Full-mode outcome and remaining limits

The official `bun run test:e2e` completed with exit 1: **259 passed, 11 failed, 1 flaky, 6 skipped and 4 did not run**. All eight `session-analyse` cases passed in this full run as well. [Full log](../.omp/evidence/session-analyse/full-mode-e2e.log), [summary and exact failures](../.omp/evidence/session-analyse/full-mode-summary.json).

The failures are outside this package: seven Compare/Spectate cases in `packages/lap-replay/test/e2e/compare/`, the Forza standalone-lap changing-telemetry case in `playwright/tests/seeded/analyse/telemetry.spec.ts`, saved chat workspaces, and two central Compare flows. AC Evo raw/debug UI was flaky. The four unexecuted cases are F1, ACC, AC Evo and iRacing changing-telemetry cases blocked by the serial Forza failure; they are not represented as passing. Skips comprise four provider-dependent Qwen cases, the unavailable standalone MoTeC fixture and an unavailable seeded single-lap no-telemetry case. These results do not establish a green repository-wide E2E baseline, and no unrelated replay/chat/telemetry behavior was rewritten to hide failures.

No checkpoint or persistent model-setting changes were made. Owned visual servers/tabs and temporary smoke/audit source files were cleaned up. The migration was not committed or pushed as part of this request.
