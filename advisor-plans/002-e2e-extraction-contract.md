# E2E-aware package extraction contract

Status: PROPOSED — planning only; no implementation authorized by this document.
Planned against `4eef7739c`, 2026-10-21, including the inspected working tree.

Goal: reduce unnecessary E2E executions without losing coverage. Package count, cache-hit rate, and test-count reduction are not acceptance goals by themselves.

Plans: [CI selection](003-e2e-selection-plan.md), [backend extraction](004-e2e-backend-plan.md), [client boundary cleanup](005-e2e-ui-plan.md).
ADR: [E2E selection before further extraction](../docs/adr/0015-e2e-aware-package-extraction.md).
Execution sequence: [Ordered change list](006-feature-extraction-change-list.md). The one-feature-package topology is agreed in conversation; implementation proposals and acceptance gates remain subject to review.
Reusable architecture authority: [Feature packages](../docs/architecture/feature-packages.md). This contract specializes that pattern for the dashboard pilot and selection rollout.

## Evidence and scope

- `package.json:7-15` already declares client, Playwright, shared, server, scripts, apps and packages as workspaces. Existing game, metadata, capture, analysis, frontend-pure and tooling packages are useful starting points, not proposed new extractions.
- `turbo.json:6-8` already enables `affectedUsingTaskInputs`. Merely adding `--affected` to existing scripts does not repair inaccurate inputs or dependencies.
- `.github/workflows/build-test.yml:165-173` calls browser E2E for every eligible PR. `.github/workflows/playwright-e2e.yml:21-119` always prepares seed data and schedules 10 matrix entries: fresh, tunes, tunes-unseeded, seven seeded shards. These labels are alternative eligible runners, not an OS test matrix.
- `.github/workflows/playwright.yml:104-139` builds and invokes Playwright directly; browser execution does not use Turbo affected selection.
- `turbo.json:613-773` defines 148 recording-E2E input patterns inherited by all owners. These include AI tune symptoms, experiments, MoTeC, metadata and capture implementations. `packages/game-acc/turbo.json:13-15` extends rather than replaces this list.
- `scripts/test/run-turbo.ts:16-27` removes `--affected` when either SCM ref is absent/unresolvable, deliberately selecting the full suite.
- `packages/game-acc/package.json:6-10` depends on `@raceiq/backend-core`. `server/package.json:209-233` makes that core depend on shared capture, metadata, telemetry and analysis packages. An ACC replay's transitive closure is therefore substantially wider than ACC parsing.
- `apps/backend/test/support/setup-app.ts:1-11` initializes all adapters and application integrations. This is appropriate for application E2E, not a neutral preload for isolated game replay.
- `playwright/turbo.json:6` replaces inherited task dependencies with a build task. The observed browser task graph contains build dependencies, not its own runtime `transit`. Do not use that task's current affected result as a complete application impact oracle.
- `client/src/lib/rpc.ts:2` imports inferred Hono `AppType` from the backend. The type-level edge is real for typechecking, even when it is not a browser runtime edge.

Read-only evidence collected: Bun 1.4.3; Turbo dry-run reports 2.11.7. Browser dry-run resolves `client#build` → `@raceiq/tooling-build#build` → `raceiq-e2e#test`; E2E caching is disabled. With `TURBO_SCM_BASE=HEAD^`, `TURBO_SCM_HEAD=HEAD`, recording dry-run selected eight executable owners: backend, frontend-contract-tests and six games. This is one actual commit comparison, not a controlled per-file attribution experiment or timing measurement. With missing refs the wrapper explicitly selected all tasks.

## Agreed boundary for independent implementation

The plans share the following proposed integration decisions. They are internally consistent but require maintainer approval; no claim of user acceptance is made. No HTTP request/response, auth, game ID, telemetry, persistence or lifecycle semantics change.

### Selection operation

The CI owner adds `scripts/test/select-e2e.ts`, invoked from the repository root:

`bun scripts/test/select-e2e.ts --base <commit-ref> --head <commit-ref> [--full]`

It must not build, seed, launch browsers, replay recordings, write application data or execute task commands. Resolve commit refs and use real Turbo 2.11.7 dry-run graphs plus declared runtime/fixture/config inputs. Do not implement a second handwritten general dependency graph or infer dependencies from package names.

Stdout is exactly one JSON object; diagnostics go to stderr:

```json
{
  "version": 1,
  "base": "resolved-full-commit-sha",
  "head": "resolved-full-commit-sha",
  "mode": "affected",
  "browser": { "run": false, "suites": [], "reason": "No browser runtime, fixture, spec, or harness impact" },
  "recordings": ["@raceiq/game-acc#test:e2e:recordings"],
  "fallbackReason": null
}
```

- `version`: required literal `1`.
- `base`, `head`: required resolved SHA strings; nullable only when the corresponding ref cannot be resolved.
- `mode`: required `affected | full`.
- `browser.run`: required boolean, equal to whether `browser.suites` is non-empty. Stage 1 selects the entire existing browser matrix or none; Stage 2 selects independently owned feature suites.
- `browser.suites`: required sorted, unique suite IDs from a version-controlled discovered suite registry. Initially `legacy` represents all existing projects. After the pilot, `dashboard`, `legacy`, and `app-smoke` are separate IDs; full mode selects every registered suite. Do not drop unmigrated tests when adding a feature suite.
- `browser.reason`: required non-empty explanation of selected dependency/input or verified absence of impact; never expose environment values or credentials.
- `recordings`: required sorted, unique executable task IDs from discovered workspace owners; transit/nonexistent commands are not executable selections.
- `fallbackReason`: required `string | null`; non-null for automatic full fallback; null for ordinary affected or explicit full mode.
- Missing refs/history, unowned executable source/fixtures, unsupported graph output, incomplete input coverage or ambiguous deletion/rename => full selection, with reason. Unrecoverable CLI/config failure => nonzero, failing the selection gate; never convert failure into an empty result.
- Explicit `--full` selects all currently configured E2Es. Workflow release gates remain full; retain `bun run test` as the explicit full local aggregate. Missing-ref wrapper behavior stays fail-open to full coverage.
- Selection JSON is current-run workflow data, not a cached test result. Changing test-result caching is out of scope; keep E2E `cache: false`.

### Runtime and type boundaries

Proposed neutral package `@raceiq/game-runtime-contracts` owns game runtime policy, detector factory/options and pipeline port types extracted from `server/games/types.ts`, `server/lap-detection/types.ts`, and `server/telemetry/pipeline-ports.ts`. It may depend on narrow existing shared/telemetry/analysis contracts, never backend, client, DB, AI runtime, concrete games or initialized registries. Do not force mixed runtime implementations into a contracts package.

Proposed `@raceiq/recording-pipeline` owns neutral processing/detection and replay support extracted from `server/telemetry/live-pipeline.ts`, `server/lap-detection/`, `server/live-strategy/` and applicable `server/games/kunos/` processing modules. Existing engines remain in `@raceiq/telemetry-core`; do not copy them. Persistence, filesystem publication, settings, profile notification, experiments, track storage/calibration and WebSocket side effects stay host-owned, supplied through existing ports extended only where necessary. Registries are host-supplied, not automatically populated by imports.

Game analysis prompt/context composition becomes a backend-owned composition path separate from game parsing/replay. `ServerGameAdapter` runtime requirements and analysis extension types must remain statically typed, with no fake empty prompt fallback. The production app still composes both. A prompt-only change must not become a recording dependency through a game package manifest, barrel, preload or root task input.

Client boundary cleanup moves browser-safe capability data to existing metadata and UI-consumed DTO types to their authoritative shared domain modules. Preserve Hono inferred RPC typing; do not cast away `AppType`, duplicate endpoint declarations, replace RPC with fetch, or add a new API abstraction merely to remove a graph edge. Typecheck dependencies and runtime E2E dependencies may differ only when validated against actual imports/build inputs.

### Vertical feature boundaries and colocated E2Es

Target architecture is one workspace per feature, owning UI, server code, feature contracts and E2Es together. Pilot: `packages/dashboard/` named `@raceiq/dashboard`, with top-level `ui/`, `server/`, `contracts/`, `test/unit/`, `test/integration/` and `test/e2e/`. Expose explicit `./ui`, `./server` and `./contracts` entry points; no mixed root barrel or separate directory manifests. Existing genuinely shared dashboard DTOs remain authoritative in shared until a cycle-free migration is justified; feature-specific host bindings and view contracts live inside the feature.

Dashboard means the Home/period/recap feature in `client/src/components/home/`, `client/src/hooks/dashboard.ts`, `apps/backend/src/routes/dashboard-routes.ts`, dashboard DB query modules and the dashboard capture processor. It does NOT mean portable live dashboards in `playwright/tests/seeded/dash/`. Existing Home coverage is `playwright/tests/seeded/landing/landing.spec.ts`.

The feature's `./server` entry exports its Hono route factory/instance with inferred type and dashboard-owned query/processor services. Its `./ui` entry exports feature view/container/hooks with an explicit typed host binding for RPC, shared controls, settings, routing and game context. Neither implementation imports the client/app composition root. UI code may import `./contracts`, never server code, DB/native modules or server initialization; server code may import contracts, never UI. Enforce these rules with scoped TypeScript projects and static import-boundary checks, including transitive imports and package exports. Browser production build and actual UI smoke must prove server code is not bundled. All imports remain static.

The feature owns its browser specs under `packages/dashboard/test/e2e/` and its `test:e2e`/`e2e:impact` tasks in the same manifest/Turbo configuration. A change to either UI or backend selects the feature's E2Es; separate subpath-level invalidation is not a goal. Real shared package dependencies remain declared, even when they conservatively widen selection. Tests run against the REAL complete compiled application, not a dashboard-only mock server. Building/starting the complete app is an execution prerequisite, separate from impact selection: `e2e:impact` covers feature source, tests, contracts and shared runtime/harness inputs without depending on the application build. The selector queries impact tasks, then dispatches actual E2Es. App composition, root router, auth, migrations, global runtime and shared harness/seed/build changes select smoke and all affected suites conservatively.

Keep `playwright/` as the shared harness/config plus residual `legacy` suite, not a second owner of moved specs. Extend Playwright test discovery to workspace-owned specs. Preserve setup projects, seeded/unseeded server sets, sequential import isolation, full discovery and cross-platform execution. New feature owners require feature-specific fixtures where safe; the common seed producer remains a real broad dependency until separated.

Legacy migration constraint: while the residual legacy owner still declares the entire app as its runtime closure, feature changes may legitimately select it. Do not claim AC-11 passed in that state. Before proving unrelated tuning skips, separate the existing tunes/tunes-unseeded project impact scopes from residual legacy coverage with complete tuning UI/backend/fixture inputs. Their E2E ownership can move before all tuning production code is extracted, but inputs remain conservative and must pass E09/E10. Any unclassified residual consumer blocks that skip, not the test itself.

Application smoke owns actual boot/auth/root navigation/route registration; cross-feature journeys have one explicit owner and dependencies on every participating feature. Examples: Home → Sessions → Analyse and tune → experiment → lap association. Do not split a journey into mocked feature assertions or duplicate the same spec across packages.

Dashboard HTTP authority remains `shared/racing/sessions/dashboard.ts` (`DashboardRequest`, `DashboardResponse`, coverage/nullability, recap types), `shared/racing/sessions/types.ts` for recap response, and `apps/backend/src/routes/dashboard-routes.ts` for validation/error behavior until relocation. Existing `advisor-plans/001-sqlite-dashboard-read-model.md` and architecture read-model invariants remain authoritative, not superseded.

Integration operations remain:

- `GET /api/dashboard?from=<instant>&to=<instant>`: required finite ISO instant strings, half-open interval, from < to, maximum 366 days; optional valid `X-Game-Id`. Auth/CSRF/origin policy remains shared host middleware. Response is the existing `DashboardResponse`, not a new DTO. Example: `/api/dashboard?from=2026-10-01T00:00:00Z&to=2026-10-21T00:00:00Z` with `X-Game-Id: acc`. Invalid query/header remains 400; shared auth denial is unchanged.
- `GET /api/dashboard/sessions/:id/recap`: positive safe integer ID, required valid game header; existing recap response or 404 `{ "error": "Session not found" }`; missing/invalid game header remains 400. Preserve existing field types and nullable values exactly.
- Existing `dashboard_updated` WS notification invalidates dashboard/recap reads; subscription owner stays in shared app transport with typed feature registration, no second socket. Mine-only ownership, calendar ordering/timezone semantics, pending/unavailable coverage, ten recent sessions and null latest recap remain unchanged.

UI/backend pilot implementations proceed in parallel in disjoint directories of the SAME feature package after contract approval. Backend owner controls `server/` and authoritative contract moves; UI owner controls `ui/`; CI/integration owner alone controls the feature manifest/exports/Turbo configuration, scoped TypeScript projects, `test/e2e/`, suite discovery and final real integration. Agree `contracts/` bindings before dependent edits; typed fixtures may support UI development, never replace production integration. Dashboard extraction must reconcile active plan 001 edits before relocation; its unresolved performance/recording work is not absorbed into extraction.

## Acceptance criteria

| ID | Observable acceptance |
| --- | --- |
| AC-01 | A docs-only change outside runtime-used assets schedules no browser matrix, browser build, seed job or recording E2E. Required aggregate check still succeeds with an explicit no-impact result. |
| AC-02 | A recording-spec-only change selects its owner and not other game replay owners; a browser-spec-only change runs browser coverage but no recording replay solely because a spec changed. |
| AC-03 | After backend extraction, a backend-only AI prompt/tune recommendation change selects relevant AI checks and browser E2E, but no recording replay unless a demonstrated runtime dependency remains. |
| AC-04 | An ACC parser/ACC fixture change selects ACC recording E2E and all actual consumers, including application/consumer E2Es and browser coverage where affected; it does not select unrelated single-game replay owners. |
| AC-05 | Shared processing/capture contract changes select every consuming recording owner and browser coverage. No fixed allowed-count cap can suppress a necessary consumer. |
| AC-06 | Unknown inputs, invalid/missing SCM refs/history, rename/deletion ambiguity and explicit full mode cannot produce a false empty selection. CLI/config errors fail closed as a failing gate or select full where specified. |
| AC-07 | Full mode preserves every existing browser project, project setup dependency, recording test and app E2E; failures propagate. No test is deleted, weakened or reclassified to claim savings. |
| AC-08 | Refactoring preserves real recorded lap times, native telemetry semantics, frame fidelity, lap classification, replay bootstraps, DB writes, notifications, production boot and shutdown behavior. |
| AC-09 | Browser runtime changes still select browser E2E even if the only package graph route was previously a type-only dependency or a build task. UI-only changes do not select game recording E2Es solely via client localization/setup. |
| AC-10 | Every implementation phase records selected task IDs, actual executed suites, pass/fail outcomes and CI jobs avoided. Report measured durations separately; claim no speedup percentage without matched evidence. |
| AC-11 | A dashboard-only UI, backend service, or owned-spec change selects `dashboard` plus application smoke and genuine cross-feature consumers, not unrelated tuning/recording suites solely because all features share one compiled artifact. Shared DB/auth/router/seed changes still select every consuming suite. |
| AC-12 | One `@raceiq/dashboard` workspace contains its UI, backend, feature contracts and E2Es with explicit entry points, no reverse app imports, no UI-to-backend runtime imports, no backend-to-UI imports and no duplicate spec ownership. Production browser bundling excludes server-only modules. Existing Home API/WS behavior, Hono RPC inference and complete full-mode test discovery remain unchanged through the actual compiled app. |

## Edge handling and shared end-to-end scenarios

The CI owner owns selection/integration evidence. Backend and UI owners supply their changed-path scenarios; completion depends on integrated execution. Reuse existing fixture-backed suites, not mock application implementations.

Extend `scripts/test/tests/` with a runnable selection regression harness. Use disposable Git worktrees and controlled commits to run the real selector/Turbo entry points against installed repository dependencies. Cover added, modified, renamed and deleted inputs. Never mutate the user's checkout to simulate changes. For runtime extraction scenarios, execute actual recording and compiled-app paths after selection, not dry-run alone. A deliberate application fault in a disposable worktree must fail the selected real gate.

| Scenario | Setup → action → expected observation | Criteria |
| --- | --- | --- |
| E01 docs | Commit a change only to a non-runtime guide in a disposable worktree; run selector and workflow-equivalent decision path → no browser/seed/replay execution; stable aggregate success. | AC-01/10 |
| E02 test ownership | Independently change one ACC replay spec, then one existing browser spec; compare selection → ACC owner only for recording-spec mutation, browser only for browser-spec mutation; no tests disappear from full discovery. | AC-02/07/10 |
| E03 AI separation | Change `server/ai/tune-symptoms.ts` or its final moved equivalent → no recording owners, browser selected; run relevant AI/unit tooling checks and existing compiled browser chat/settings coverage without external AI calls. Separately change an actual game analysis prompt and obtain the same separation. | AC-03/08/10 |
| E04 game isolation | Change ACC parser and, separately, an ACC fixture → ACC and genuine application/consumer gates selected; FM/F1/iRacing/LMU replay not selected absent a real dependency. Run existing ACC recorded fixture E2Es and compiled seeded replay/Analyse coverage against the actual application. | AC-04/08/10 |
| E05 shared change | Change shared framing or extracted pipeline runtime → all actual consumer tasks selected; execute affected recording suites and existing compiled fresh/seeded browser coverage. Verify frame/lap fidelity and persisted results. | AC-05/08/10 |
| E06 failures and SCM | Missing refs, shallow history, root lock/config changes, unowned source, deleted/renamed fixtures, malformed Turbo output → explicit full selection or specified failing gate, never silent skip. Fail one selected real replay/browser assertion in the disposable worktree → aggregate fails. | AC-06/07/10 |
| E07 full equivalence | Full selector → existing browser discovery/project dependencies and all owner manifests exactly preserved; execute full browser and recording suites once after final integration, including setup/migration projects. Manual full workflow exercises the same path. | AC-07/08/10 |
| E08 client boundary | Change a client runtime module, iRacing browser capability, then a locale; browser selected each time, no recording E2E solely through localization. Execute compiled live/seeded browser path consuming each changed contract and validate actual API/WS rendering. | AC-08/09/10 |
| E09 vertical pilot | In separate disposable commits change UI, backend query/service, then a spec INSIDE `packages/dashboard/` → the same dashboard E2E task + app smoke + genuine cross-feature consumers selected; unrelated tuning suites skipped. Inject a forbidden UI-to-backend import → boundary gate fails; remove it, build production browser output and verify server-only modules are excluded. Execute dashboard E2E through permitted exports against the compiled app with real SQLite/API: global/per-game periods, mine-only totals, recap navigation and post-write WS refresh remain correct. Inject an owned query failure → selected real gate fails. | AC-08/10/11/12 |
| E10 shared and discovery | Change auth, root router, DB migration, common seed, then shared build harness → every consuming feature suite selected. Compare full-mode discovery before/after moving specs: identical test identities/counts apart from intentional file paths, no duplicate setup execution beyond existing semantics. Execute real Home → Sessions → Analyse journey, empty/pending/error/recovery states, fresh install and full remaining legacy suites. | AC-05/06/07/08/10/11/12 |

Each scenario records base/head SHA, selection JSON, command, platform, exit status and relevant assertions. Existing native replay is not evidence of live Windows shared-memory capture; use supported Windows validation if native reader code changes. Keep stateful import specs, setup migrations, feature flags, fresh/unseeded states and per-run isolated data/ports intact.

## Completion and rollout

CI selection can ship before extraction with conservative over-selection. Backend and UI work may proceed in parallel after this contract is approved, with disjoint ownership and one CI integration owner. Do not wait for a perfect package graph to stop docs-only browser runs. Do not declare AC-03/04 complete until physical package dependencies and preloads are narrow enough.

Run selector in shadow mode on real PRs before enabling skips: log actual selection alongside existing gates; investigate every disagreement. Then enable gating for proven classes, with unknown classes falling back to full. All E01–E10 must pass after final integration before marking this extraction programme complete. No implementation tests/builds were executed during planning; only dry-run graph inspection was performed.

Official references: [Turbo affected/dry-run semantics](https://turborepo.dev/docs/reference/run), [configuration and task inputs](https://turborepo.dev/docs/reference/configuration). Repository is on 2.11.7; validate flags with that CLI, do not adopt newer documentation features implicitly.
