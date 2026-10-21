# Feature-package extraction: ordered change list

Status: PLANNED. The user agreed to one feature package owning UI, backend, contracts and E2Es. This change list does not authorize implementation, commits or changes to test coverage.

Based on the analysis of `4eef7739c` and the inspected working tree. Revalidate affected source before implementation; preserve unrelated changes.

## Authoritative implementation documents

- [Shared contract, AC-01–12 and E01–10](002-e2e-extraction-contract.md).
- [CI, selection and E2E ownership plan](003-e2e-selection-plan.md).
- [Backend implementation plan](004-e2e-backend-plan.md).
- [UI implementation plan](005-e2e-ui-plan.md).
- [Architecture decision](../docs/adr/0015-e2e-aware-package-extraction.md).
- [Reusable feature-package architecture pattern](../docs/architecture/feature-packages.md).

This document sequences independently reviewable change sets; it does not combine or replace the separate UI/backend plans. Request/response definitions, ownership semantics and scenario expectations remain authoritative in the shared contract.

## Fixed decisions

- One workspace: `packages/dashboard/`, named `@raceiq/dashboard`.
- Feature owns top-level `ui/`, `server/`, `contracts/`, unit/integration tests and `test/e2e/`; there is no intermediate `src/` directory.
- Explicit `./ui`, `./server`, `./contracts` exports; one package manifest, no mixed root barrel.
- UI and backend changes both select the feature E2Es. Subpath-level invalidation is not a goal.
- Thin app route/boot bindings remain in the application. Feature code cannot import app composition roots.
- Tests use the real complete compiled application and isolated data, not a feature-only fake server.
- Full-app build is an execution prerequisite, separate from feature impact selection.
- Shared auth/router/DB/boot/harness changes select every genuine consumer. Unknown impact falls back to full coverage.
- Existing full local/release execution remains available; no E2E result-cache changes.

## Change sets and dependencies

| ID | Change set | Depends on | Observable completion |
| --- | --- | --- | --- |
| CL-01 | Conservative affected selection and provisioning gate | None | Docs-only changes avoid E2E seed/build/matrix; unsafe/unknown cases run full or fail visibly. |
| CL-02 | Complete dashboard feature-package cutover | Relevant dashboard work reconciled; shared bindings fixed | One package owns working UI, backend, contracts and existing feature tests; old implementation paths removed. |
| CL-03 | Feature E2E discovery and independent impact scopes | CL-02 interfaces; same pilot landing milestone | Dashboard owns its E2Es; full discovery retained; tuning/residual scopes cannot accidentally swallow every feature change. |
| CL-04 | Activate selective feature CI | CL-01, CL-03 | Dashboard-only changes run dashboard/smoke/dependent journeys, not unrelated tuning suites; shared changes still fan out. |
| CL-05 | Narrow replay ownership and inherited inputs | CL-01; actual dependency map | Test-only/UI changes stop triggering unrelated game replay; actual shared runtime inputs retain full consumer coverage. |
| CL-06 | Isolate neutral game runtime from backend features | CL-05 selection baseline | AI-only changes stop selecting recording replay; ACC-only changes avoid unrelated game replay. |

CL-01 and CL-02 can be developed independently. CL-02 UI/backend work can proceed in parallel under one integration owner. CI-owned E2E relocation integrates with that cutover, not a separate editor racing over feature files. CL-05 can proceed independently of dashboard extraction once its actual runtime dependencies are mapped. CL-06 follows the recording baseline; it is not a prerequisite for dashboard feature ownership.

CL-02 and CL-03 are separate review/work slices of ONE complete dashboard landing milestone. They may be developed in parallel once bindings are fixed; they do not require sequential deployment. Do not land an empty scaffold, a half-migrated feature or a package that still leaves its feature E2Es centrally owned. The integrated milestone must preserve a runnable application and all existing coverage.

## CL-01 — Conservative affected selection and provisioning gate

**Owner:** CI/integration. **Implementation:** CI plan steps 1–3 and shadow rollout.

**Change:**

1. Add `scripts/test/select-e2e.ts` with the exact JSON/ref/full-fallback contract.
2. Add real CLI/Turbo selection scenarios in the existing tooling test area, using disposable Git worktrees and controlled commits.
3. Compute selection once from actual base/head history. Initially browser coverage is all-or-none; do not pretend current app-wide dependencies already provide feature precision.
4. Gate seed/build/browser provisioning before expensive jobs begin. Keep an always-running stable aggregate check that fails for selected-job failures and selector errors, but succeeds for a proven no-impact skip.
5. Preserve full local aggregate, manual full execution, release gates, platform-specific compilation and strict environment semantics.

**Acceptance:** AC-01/06/07/10 through E01/E06/E07. Docs-only change starts no E2E preparation or matrix jobs. Missing refs/history, unsupported graph output, deleted/renamed unknown inputs and malformed selection cannot silently skip. A deliberately failing selected real test fails the aggregate.

**Verification:** real selector/process scenarios plus a real GitHub Actions run proving job scheduling and aggregate behavior. Run existing tooling runner, shard coverage, changed-scope typecheck/lint. Record Actions access limitations as unverified acceptance, not success.

## CL-02 — Complete dashboard feature-package cutover

**Owners:** backend and UI implementers in disjoint directories; one integration owner for manifest/exports/config/shared bindings. **Implementation:** backend B0 and UI U0, against the shared contract.

**Change:**

1. Reconcile overlapping dashboard work from plan 001 before moving files. Agree host binding interfaces and exact file ownership; do not redesign outstanding read-model behavior.
2. Add the feature manifest, explicit exports, UI/backend TypeScript scopes and import-boundary rules. Reuse existing source-export workspace conventions and existing genuinely shared DTOs.
3. Move Home components and dashboard-specific hooks to `ui/`; keep thin global/per-game route wrappers in client. Replace reverse app imports with typed host bindings or genuinely shared primitives.
4. Move dashboard routes, feature-owned queries/services and processor to `server/`. Leave shared DB connections, schema/migrations, write coordination and non-dashboard services platform-owned. Bind real persistence, registry/catalog, notifications and lifecycle at the host.
5. Put feature-owned host/view contracts in `contracts/`. Preserve Hono inferred route typing and shared API field/nullability/error behavior.
6. Move exclusively dashboard unit/integration tests into the feature; include Home E2E relocation/discovery from CL-03 in the landed cutover if required to keep complete ownership. Keep cross-feature tests with one explicit integration owner.
7. Migrate every caller and remove obsolete implementation paths/exports. No duplicate implementations, shims, no-op production callbacks or dynamic imports.

**Acceptance:** AC-08/12 through E09/E10, plus AC-07 discovery preservation. `@raceiq/dashboard/ui` renders existing Home behavior; `@raceiq/dashboard/server` serves real dashboard/recap operations and sends existing refresh notifications. Production browser output excludes server/DB/native code.

**Edges and handling:** preserve mine-only ownership, global/per-game periods, UTC interval boundaries, null recap/no sessions, pending/unavailable coverage, API errors/recovery and post-write refresh. Preserve startup/processor shutdown and registration order. No DB migration or public API shape change is introduced by relocation. Forbidden UI-to-backend imports must fail the boundary gate, not merely rely on reviewers noticing them.

**Verification:** existing dashboard query tests plus actual compiled Home/API/SQLite/WS E09/E10. Inject a forbidden import in a disposable worktree and observe rejection; restore it and verify production bundling and real browser behavior. Run root and explicit feature/client/backend typechecks, lint and production build. Keep failed baseline checks distinct from newly introduced failures.

## CL-03 — Feature E2E discovery and independent impact scopes

**Owner:** CI/integration; tests remain feature-owned inside `packages/dashboard/test/e2e/`. **Implementation:** CI plan step 4b.

**Change:**

1. Move `playwright/tests/seeded/landing/landing.spec.ts` once; preserve assertions and setup/fixture requirements. Portable dashboard specs under `seeded/dash/` are a different feature and stay put.
2. Extend shared Playwright configuration/discovery to feature-local specs. Keep setup projects, seeded/unseeded server sets, sequential import handling and per-run isolated databases/ports.
3. Register `@raceiq/dashboard#test:e2e` and side-effect-free `e2e:impact`. Impact covers the entire feature, tests, contracts and genuine shared dependencies; execution still uses the real complete compiled app.
4. Keep a small real app-smoke gate and an explicit owner for Home → Sessions → Analyse and other cross-feature journeys. Declare every participating dependency; do not duplicate those specs in feature and legacy suites.
5. Separate existing tunes/tunes-unseeded impact scopes from app-wide legacy selection before claiming a dashboard change skips tuning. Remaining unclassified consumers stay conservative; broad legacy selection is an explicit incomplete-isolation result.

**Acceptance:** AC-02/07/10/11/12 through E02/E07/E09/E10. Full discovery preserves all test identities/coverage after accounting for moved file paths. Dashboard UI/backend/spec mutations select the same dashboard suite. No test is unowned or owned twice.

**Verification:** compare complete before/after discovery, execute actual relocated dashboard E2Es and cross-feature journey, then exercise controlled positive/negative impact cases. Run full browser coverage after discovery changes; a passing `--list` or dry-run alone is insufficient.

## CL-04 — Activate selective feature CI

**Owner:** CI/integration. **Implementation:** CI plan final integration/rollout.

**Change:**

1. Shadow-run feature selection while existing browser gates still execute; inspect discrepancies rather than assume dependency correctness.
2. Pass selected suite IDs to workflow matrix construction; only provision selected suites' preparation/jobs. Keep broad shared seed dependencies until genuinely separated.
3. Enable proven skip classes only; unknown impact still selects full. Preserve required aggregate checks, failure propagation, full mode and platform/server-set behavior.
4. Update contributor execution commands and one coherent Internal changelog note after integrated proof. Record job counts and matched timings separately; do not invent a savings target.

**Acceptance:** AC-01/05/06/07/09/10/11/12 through E01/E05/E06/E07/E08/E09/E10. A dashboard UI change, backend service change and feature spec change each run dashboard plus smoke/genuine dependent journeys. Unrelated tuning suites do not run merely because one complete app binary was rebuilt. Shared auth/router/migration/seed/build changes retain every consuming suite.

**Verification:** real CI no-impact, feature-impact, shared-impact, forced-full and deliberate-failure runs. Execute the real compiled app E2Es in each selected-impact class. Run full browser/recording coverage once after final integration; record actual outcomes. CL-04 is not complete while a broad legacy owner still selects unrelated tuning tests for every dashboard change.

## CL-05 — Narrow replay ownership and inherited inputs

**Owner:** CI integration for root task configuration; package owner for replay-local inputs. **Implementation:** CI plan step 4 and backend B1/B5.

**Change:** map actual recording owner imports, fixtures, test preloads and external runtime inputs. Replace the inherited 148-pattern root list owner by owner only when every removed input has a real dependency/input replacement. Keep each suite manifest and tests as direct inputs even when tests are excluded from dependency transit. Remove client localization/setup dependencies only from replay tests that do not use client code. Keep real frontend-contract and all-game application E2Es separate and honest.

**Acceptance:** AC-02/05/07/09/10 through E02/E05/E07/E08. Test-only changes select their owner; UI/locale-only changes do not select game replay solely through accidental setup. Shared capture/runtime changes still select every consumer. Remaining broad backend-core dependencies are reported, not deleted from manifests to improve counts.

**Verification:** real selector worktree scenarios followed by actual selected fixture replay, affected consumer/application E2Es, shard coverage and typecheck/lint. Do not claim AI/parser isolation until CL-06 passes.

## CL-06 — Isolate neutral game runtime from backend features

**Owner:** backend/runtime implementer, with CI integration. **Implementation:** backend B2–B5; keep this as a separate reviewed milestone from dashboard extraction.

**Change:** extract neutral game/detector/pipeline contracts and recording processing into the proposed foundation workspaces, reusing existing telemetry/capture engines. Keep DB/metrics/experiments/notifications/filesystem and lifecycle effects host-bound. Separate game analysis composition from replay dependencies, migrate all six game callers and remove backend-core manifest edges only after their last real imports are gone. Do not create per-feature layer packages as a new default; these foundation packages exist because several independent games consume the same runtime contract/algorithm.

**Acceptance:** AC-03/04/05/08/10 through E03/E04/E05/E07. AI-only changes select relevant AI/browser checks, not recording replay; ACC-only parser/fixture changes select ACC plus actual consumers, not unrelated game replay. Shared processing changes select every consumer. Preserve exact replay frames, lap/sector/classification results, stateful checkpoints, real DB side effects and shutdown behavior.

**Verification:** actual committed game fixture replays, cold F1/iRacing checkpoint replay, all-game application integration and compiled browser paths. Supported-Windows capture verification is required if native-reader implementations change; replay-only evidence cannot claim native capture proof. Execute full integrated E01–E10 before declaring the entire extraction programme complete.

## Later feature rollout

After the pilot proves ownership and selection, apply the same ONE-package structure to tuning/setup, then sessions/import, then Live/Analyse/Compare. These are sequencing recommendations, not sufficiently researched implementation assignments: each needs a feature-specific change list, shared contract and separate UI/backend plans before edits. Do not mechanically rename directories or create packages per page.

## Evidence and completion policy

The shared contract owns scenario setup/action/expected results and edge handling; all change sets above map to those stable IDs. Implementation records base/head, selected IDs, commands, platform, actual execution outcomes and CI scheduling evidence. Unit/static checks supplement real application E2Es, never replace them. No skipped, blocked or unexecuted gate is a pass.

Planning-only verification: document links and consistency. No builds, runtime suites, workflow dispatches, source changes or checkpoint files are required to deliver this change list.
