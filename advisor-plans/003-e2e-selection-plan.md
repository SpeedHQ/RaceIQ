# Plan 003: Skip unaffected E2E jobs before provisioning

Status: TODO / PROPOSED. Priority P1. Effort M. Risk medium: false negatives can hide regressions.
Planned at `4eef7739c`, 2026-10-21. Planning does not authorize execution or commits.

Shared authority: [E2E extraction contract](002-e2e-extraction-contract.md), especially AC-01–12, E01–10 and the selection JSON operation. This plan owns CI selection, feature E2E ownership and final integration evidence, not backend or UI implementation.
ADR: [Decision](../docs/adr/0015-e2e-aware-package-extraction.md).
Parallel counterparts: [backend](004-e2e-backend-plan.md), [UI](005-e2e-ui-plan.md).

## Current state and rationale

The highest-leverage change is not another package. `.github/workflows/build-test.yml:165-173` always invokes the browser workflow for eligible PRs. `.github/workflows/playwright-e2e.yml:21-119` unconditionally prepares seed data and schedules 10 matrix entries. `.github/workflows/playwright.yml:104-139` builds and invokes Playwright directly. No affected selection guards those costs.

`turbo.json:6-8` already has task-input-aware affected selection. But `test:e2e:recordings.inputs` has 148 patterns shared by every recording owner, and `test.inputs` has 149. `playwright/turbo.json:6` replaces the inherited transit dependency with `@raceiq/tooling-build#build`. Current dry-run has no runtime transit dependency attached directly to the browser task. First establish a complete selection model; adding `--affected` to this incomplete graph would be unsafe.

Exemplar: `scripts/test/run-turbo.ts:16-27` verifies both SCM refs and deliberately runs full selection when unavailable. Preserve that safety contract. `scripts/playwright-ci.ts` retains Node-backed Playwright execution and discovery/failure handling. `scripts/test/tests/owner-runner.test.ts` demonstrates isolated child-process integration testing and cleanup.

## Ownership and exclusions

Own `scripts/test/select-e2e.ts` (new), selection integration coverage under `scripts/test/tests/`, `scripts/test/tooling-files.txt`, applicable runner changes in `scripts/test/run-turbo.ts`, `scripts/test/run-all.ts`, `scripts/run-browser-verification.ts`, `scripts/playwright-ci.ts`, root/package Turbo selection configuration, and `.github/workflows/build-test.yml`, `playwright-e2e.yml`, `playwright.yml`. Own corresponding contributor documentation and one coherent Internal changelog note after implementation.

Do not alter application algorithms, schemas, API payloads, test assertions, native-reader logic, visual-regression policy, release smoke behavior or runner-label semantics. Backend owner supplies package-local replay inputs; coordinate root input edits through this plan's single integration owner. Do not enable result caching or remote caching in this change.

## Steps and gates

### 1. Inventory actual executable gates and establish selection tests

Use discovered workspaces and `test/*-files.txt` owners; record baseline executable task IDs and Playwright `--list` discovery, including setup dependencies. Include both browser and recording lanes: the inspected PR workflow runs browser gates, while `native-replay.yml` is manual and recording E2E also runs through the local aggregate. Do not claim PR recording savings for a lane that was not running there.

Add the disposable-worktree harness from contract E01–E10. Use current installed Turbo 2.11.7 and real workspace manifests. Validate executable tasks rather than counting transit/nonexistent task nodes. Add deterministic cleanup and bounded diagnostics; keep application data isolated. Record the original all-run selection for comparison.

Verify: `bun run test:shards` exits 0; new selection harness passes current conservative-baseline expectations. These checks supplement later real E2E execution.

### 2. Add complete selection operation, conservatively

Implement the exact CLI/JSON contract. Both base/head must be resolvable; enumerate changed paths with rename/deletion handling. Use real Turbo dry-runs for task selection and declared inputs. Cover executable inputs outside workspaces, root configs, lockfile, fixtures, generated data, workflow/build/server-launch code and runtime assets. A docs extension is not sufficient to prove irrelevance: runtime guides/assets can be bundled/read by the application.

Initially allow browser all-or-none selection only. Add explicit task edges/inputs covering the actual client/backend runtime and seed/harness closure; do not trust the current browser task graph or build dependency alone. Use a conservative full-runtime closure while backend and client boundaries remain broad. Unknown changed source or input classification selects full. Invalid output/config errors fail the gate rather than produce no tasks.

Keep full local aggregate semantics (`bun run test`), explicit full execution, missing-ref fallback, strict environment handling, feature flags and platform identity. Provide a convenient affected E2E entry using the selector without silently changing existing full commands.

Verify: contract E01/E02/E06 through real selector process invocation; same valid refs give deterministic sorted selections. Existing CLI commands still resolve; search all command references before renames. Run `bun run typecheck` after implementation, not during this planning request.

### 3. Gate browser provisioning and preserve required checks

Compute selection once with full history and actual PR base/head; pass selected output into reusable workflows. Gate both seed job and matrix before install/build/browser setup. Initially preserve all existing 10 matrix entries when `browser.run=true`; do not add unsafe route-specific skipping.

Add an always-running stable aggregate result that succeeds for a proven no-impact skip and fails for selector errors or selected-job failures/cancellation. Do not make a selected failed/skipped dependency look successful. Preserve existing required-check names where possible; inspect repository branch protection before changing externally required names. Do not change protection settings as part of implementation.

Support manual force-full through the existing workflow entry and retain release gates. Avoid using PR source as shell text; pass refs as environment/argument data. Do not expose credentials or grant extra workflow permissions. Keep platform-native compiled binaries per runner architecture; do not reuse a mismatched artifact.

Verify: E01 proves no seed/matrix jobs provisioned, E06 proves failure propagation, E07 exercises manual full. Run equivalent local selector/dispatch decisions and validate a real GitHub Actions run before claiming CI scheduling is verified. If workflow execution access is unavailable, report that exact acceptance gap.

### 4. Remove shared root implementation inputs owner by owner

After dependency closure is established, replace the blanket 148-input recording list and broad browser inherited `test` inputs with package-local inputs and real dependency transit. Narrow `$TURBO_DEFAULT$` only with preserved source/fixture/config coverage. Include each owner's suite manifest, support files, codecs and shared setup it actually uses. Tests excluded from transit must still invalidate their own test task. Handle `.spec.ts` browser inputs separately from Bun `.test.ts` inputs.

Do not remove external file inputs before replacing their dependency route. Never copy the entire old list into every package. Backend plan owns breaking backend-core/runtime preload dependencies; until that lands, over-select honestly.

Verify: E02/E04/E05/E08 selection scenarios. Root `bun run test:shards` retains all manifest entries. In coordination with backend work, `bun scripts/test/run-turbo.ts test:e2e:recordings --affected --dry=json` must show complete executable consumer selection with controlled base/head.

### 4b. Add E2E ownership inside each feature package

Own `packages/dashboard/test/e2e/` and, as sole integration editor, `packages/dashboard/package.json`, package exports, scoped TypeScript configuration and Turbo tasks. Backend/UI implementers own disjoint top-level `server/` and `ui/` directories in this same workspace. Move Home coverage from `playwright/tests/seeded/landing/landing.spec.ts` once, preserving assertions and setup/fixture dependencies. Residual tests remain in the existing `legacy` owner; shared config/servers stay in `playwright/`. Maintain `app-smoke` as a small actual boot/auth/root-navigation/route-registration gate and explicit ownership for cross-feature journeys. Do not create a separate dashboard test workspace or duplicate moved specs.

Add side-effect-free `@raceiq/dashboard#e2e:impact` covering the entire feature's UI, backend, contracts, test inputs and actual shared dependency closure. Both UI and backend edits intentionally select `@raceiq/dashboard#test:e2e`. Selection uses impact tasks, then executes real feature E2Es against the full compiled app. Do not infer independent invalidation from subpath exports or let an app-build execution dependency infect every impact graph; preserve shared build/composition/seed impact inputs. Unknown/unmigrated behavior remains conservatively covered by `legacy` until independently scoped.

Extend the selector JSON's `browser.suites` and workflow matrix to selected registered suites, retaining existing server sets, setup dependencies and platform rules. If dashboard uses the common seed, that seed code is a real impact dependency. Build/seed only for selected suites; sharing safe preparation must not make tests share mutable runtime databases. Whole `client`/backend dependencies and all-game preloads in the E2E impact graph defeat isolation; replace them with real feature closures or report incomplete isolation.

Verify E09/E10: dashboard UI, backend query/service and owned-spec mutations select dashboard + app smoke + genuine cross-feature consumers, not unrelated tuning E2Es; auth/root/migration/shared seed changes still select every consumer. Compare complete discovery before/after, execute the real dashboard suite and cross-feature Home → Sessions → Analyse flow, and run full mode once after integrated extraction.

Verify AC-12's browser/server boundary using scoped UI/backend typechecks, static import-boundary enforcement and production browser build/module evidence. Add a deliberately forbidden UI-to-backend import in a disposable worktree: the boundary gate must fail. Remove it, rebuild, then exercise the real dashboard UI/API to confirm the permitted exports work and server-only modules are absent from the browser bundle. Record both rejection and successful integrated execution with E09/E10 evidence.


### 5. Shadow, enable, measure and integrate

First log selector results while current full browser gates still run. Review disagreements for docs, test-only, UI, parser, shared runtime, config and fixture changes. Enable skips only for classes covered by passing scenarios; otherwise full fallback. No fixed number of PRs substitutes for scenario evidence.

Execute E01–E10 with backend/UI owners' runtime proofs. Record selected owners, jobs actually started, test outcomes and matched before/after durations; count avoided seed/build/matrix work separately from faster tests. Keep full suite coverage intact and run it once after final integration. Update contributor commands and Internal changelog once for the coherent change.

## Acceptance and end-to-end verification

This plan owns AC-01/02/05/06/07/10/11/12 and integration verification of AC-03/04/08/09. Use the authoritative scenario setup/actions/results in the [contract](002-e2e-extraction-contract.md#edge-handling-and-shared-end-to-end-scenarios), not a duplicate interpretation. Edge handling includes unknown input, changed root lock/config, missing history, deleted/renamed files, explicit full, empty selection, task/config failure, selected-test failure, setup dependencies, feature-spec ownership, shared-shell fanout and architecture-specific binaries.

Implementation commands (dependencies already installed; no installation authorized here):

| Command | Expected result |
| --- | --- |
| `bun run test:shards` | Every existing/new owned Bun test assigned exactly once. |
| `bun scripts/test/run-suite.ts tooling --package @raceiq/tooling` | Existing and new selector/runner tooling integration tests pass. |
| `bun run typecheck` | Exit 0. Also run explicit changed-package typechecks if affected refs omit edited scope. |
| `bun run lint` | Exit 0. |
| `bun scripts/test/select-e2e.ts --base <scenario-base> --head <scenario-head>` | Contract JSON and exact E01–E10 expectations. New command, to be implemented. |
| `bun scripts/test/select-e2e.ts --base <base> --head <head> --full` | Every executable recording owner plus browser selected. New command. |
| `bun run test:e2e:recordings` with valid scenario refs | Actual selected fixture replays pass; missing refs intentionally run full. |
| `bun run test:e2e` | Existing compiled browser integration passes after final integration. |

Do not run these implementation gates merely to complete planning. Selection/dry-run success is not runtime E2E proof. Required Actions gating proof and full runtime evidence must be linked from implementation status before marking DONE.

## Stop conditions and maintenance

Stop narrowing affected selection if any runtime input cannot be accounted for, the installed Turbo output differs, or a consumer is missing. Retain full fallback and report the exact dependency. Do not repair by hiding a task/input. If a required check name cannot be preserved, obtain the maintainer's branch-protection decision before cutover.

Future packages, runtime assets, fixtures and setup commands must update selection coverage. Every new E2E owner needs a full-mode discovery entry and at least one positive and one negative selection scenario. Keep this mapping authoritative in runnable tests and package configuration, not parallel prose allowlists.
