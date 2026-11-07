# Precise Turbo affected verification

Status: implementation in progress; hosted CI and hardware verification remain blocked.

Planned against commit `900faf29b`, 2026-11-03. Installed toolchain: Bun 1.4.4, Turbo 2.11.7.

ADR: [Use task-level impact selection before verification provisioning](../../adr/0016-task-level-affected-verification.md).

## Revision: base CI graph with affected Turbo tasks

This revision supersedes the coarse-gate revision and conflicting earlier implementation requirements. Restore the `origin/main` CI dependency graph and existing shard layout; execute existing verification steps and shards through Turbo affected tasks instead of introducing a separate matrix selection graph. Preserve existing replay fixes. Use affected selection, not caching, for browser shards.

### Acceptance criteria

- BG01: CI retains the base workflow dependency graph, job identities, shard layout, prerequisites, and full test inventory. Each affected verification step or shard executes its existing command through a Turbo task; an unaffected task does not execute its test command.
- BG02: Turbo task inputs and dependency edges include all actual source, test, fixture, runner, configuration, and transitive dependencies. Unknown ownership or untrustworthy selection cannot silently skip verification.
- BG03: Missing, equal, invalid, or unavailable refs and selection failures visibly fall back to full execution. Manual workflows default to full.
- BG04: Browser, visual, hardware, and build results are not newly cached. Existing required job failure and cancellation behavior is preserved; successful unaffected tasks do not falsely hide failures.

### Tasks and end-to-end verification

One implementation owner restores and adapts existing CI workflows, Turbo task definitions, callers, tests, and documentation. Preserve unrelated changes and do not alter product code. The coordinator runs checks and an independent checker exercises the implementation.

| Scenario | Setup, action, observable result | Criteria |
|---|---|---|
| BG-E1 | In an isolated Git workspace, change an owned test and invoke its actual CI/Turbo entry point. The affected task executes the original command, including its existing shard identity. | BG01, BG02 |
| BG-E2 | Change an unrelated document and invoke the same entry point. Turbo reports the verification task unaffected and its test command does not run; the CI job succeeds. | BG01, BG02, BG04 |
| BG-E3 | Change shared production, fixture, or configuration inputs. Invoke affected selection and confirm every real consumer runs, including required browser shards. | BG01, BG02 |
| BG-E4 | Supply missing, equal, invalid, or unavailable refs; simulate selector failure or unknown ownership. Confirm diagnostic and full execution. Manual default executes full. | BG02, BG03 |
| BG-E5 | Inject a failing or cancelled required task and observe that its CI job fails or cancels; confirm selected browser shards execute again rather than returning cached results. | BG04 |
| BG-E6 | Compare the base and revised workflow graphs and Playwright discovery inventories. Execute representative compiled browser journeys and original shard commands, then exercise affected, unaffected, fallback, and failure paths in actual hosted CI and native WebGPU on its runner. | BG01–BG04 |

Use existing suites and deterministic isolated fixtures. Local mock or query-only checks supplement but cannot replace the actual workflow and application integration. Record outcomes below; unavailable hosted CI or hardware remains blocked, not passed.


## Revision: coarse affected gates

This revision supersedes conflicting browser/visual selection requirements and tasks below, including AC06–AC09 and E2E cases that require feature-specific matrix selection. Preserve the ordinary test, cache, replay, and full-coverage requirements. Keep existing shards and execute the full existing matrix whenever its verification category is affected.

### Acceptance criteria

- CG01: A trustworthy Turbo affected query selects each existing test category as a whole. An affected category executes its complete existing shard matrix; a proven unaffected category does not provision its test jobs.
- CG02: A stable required aggregate passes only after successful selection and either an unaffected result or successful completion of every required shard. Failed, cancelled, or unexpectedly skipped required jobs fail the aggregate.
- CG03: Invalid, missing, equal, or unavailable refs, incomplete ownership, malformed output, or selector/query failure select full verification with a diagnostic. Manual execution defaults to full.
- CG04: Existing browser projects, visual checks, seeded prerequisites, and native WebGPU coverage remain intact; no E2E or build caching is enabled. Turbo task dependencies and inputs must conservatively cover their consumers.

### Implementation and verification

One implementation owner updates CI workflows, Turbo selection and its tests, and affected documentation. Retain existing reusable workflows and shard definitions; remove obsolete per-project selection machinery where no longer needed. The coordinator owns integration and verification; an independent checker exercises the final entry points.

Use isolated Git workspaces and the real Turbo and selector entry points. Record results here before claiming completion:

| Scenario | Setup, action, expected result | Criteria |
|---|---|---|
| CG-E1 | Change an owned test or production input; invoke affected selection and the existing test entry point; category selected and its complete existing matrix runs. | CG01, CG04 |
| CG-E2 | Change only a non-verification document; invoke affected selection; no test jobs selected and aggregate succeeds. | CG01, CG02 |
| CG-E3 | Use missing, equal, invalid, or unavailable refs; induce malformed/query failure and unknown ownership; selector reports full verification. Manual default also selects full. | CG02, CG03 |
| CG-E4 | Exercise failed, cancelled, and unexpectedly skipped required shards in the workflow integration; aggregate fails. Successful shards and valid empty selection pass. | CG02 |
| CG-E5 | Compare actual Playwright discovery and visual/hardware gates with the prior full inventory; run representative compiled application journeys and selected existing shards. | CG01, CG04 |
| CG-E6 | Run actual hosted workflows for affected, unaffected, and fallback changes; observe provisioning and required status. Exercise native WebGPU on its authorized runner. | CG01–CG04 |

Reuse existing CI and Playwright suites. Local workflow simulations or mocks supplement, but do not replace, hosted execution. Hosted CI, branch protection, and hardware evidence remain blocked until available; record all outcomes and do not claim completion for unexecuted scenarios.

Revision verification: `bun test scripts/test/tests/affected-verification.test.ts` passed 13 tests and 130 assertions. Independent selector checks covered affected, docs-only, unknown input, equal and invalid refs, malformed/query failures, and inventory parity. Local aggregate shell simulation rejected failed, cancelled, and unexpectedly skipped required shards. Actual full shard execution, hosted workflow provisioning and aggregate statuses, branch protection, and native WebGPU remain unverified; these local results do not satisfy CG-E1–CG-E6 in full.


## Goal and boundaries

Run only verification tasks affected by a trustworthy change range, plus their required execution prerequisites. Skip unnecessary browser and visual job provisioning. Preserve conservative full coverage when impact cannot be established.

This is a tooling/CI implementation plan. The user additionally authorized the replay fixes covered by AC12 and AC13. It does not delete low-value tests from the preceding audit.

### Authoritative existing contracts

- [Feature package architecture](../../architecture/feature-packages.md#tests-and-turbo-selection): feature-owned browser suites exercise the complete compiled application; `e2e:impact` is separate from build prerequisites; shared infrastructure selects consumers; unknown impact retains full coverage; E2E results remain uncached.
- [Feature extraction decision](../../adr/0015-e2e-aware-package-extraction.md): retain feature ownership, application smoke, cross-feature journeys, and residual legacy coverage without inventing new packages for selection.
- [Previous tooling plan](review-fixes-tooling-plan.md), AC14: manual verification with equal/missing/unusable ranges must still execute full requested gates. Preserve this behavior; fixing ordinary local defaults must not accidentally narrow manual runs.
- `scripts/test/owners.ts` and owner `test/*-files.txt` files remain authoritative for ordinary test ownership. `playwright/config/projects.ts` remains authoritative for browser project discovery.

## Current state and evidence

- `turbo.json:6–8` already enables `futureFlags.affectedUsingTaskInputs`.
- `scripts/test/run-turbo.ts:17–33` strips `--affected` unless both explicit SCM variables resolve to different commits. This prevents local commands without explicit variables from using Turbo's native default comparison.
- `scripts/test/tests/run-turbo.test.ts:26–69` currently requires full selection for equal, empty, and missing refs without distinguishing local from manual invocation.
- Root unit inputs use `$TURBO_DEFAULT$`. Tooling/integration/recording inputs additionally inherit long, shared domain-file lists in `turbo.json:289–774`. These widen selection and cache invalidation across unrelated owners.
- `transit` excludes ordinary test files but still carries other package inputs. A test-only change must not leak through a manifest/helper/fixture left in transit accidentally.
- Catalogue packages already expose `e2e:impact` and `test:e2e`; execution depends on the complete compiled app. Reuse these tasks.
- `.github/workflows/build-test.yml` supplies PR SHAs and full history for affected unit/tooling/integration tasks. Browser and visual workflows are called unconditionally for eligible PRs.
- `.github/workflows/playwright-e2e.yml` provisions a seed producer and ten matrix entries, plus native WebGPU, irrespective of affected features.
- `scripts/turbo.json` intentionally consumes frontend sources for theme checks. This real cross-boundary dependency must remain represented.
- Prior audit dry run without explicit refs selected 41 packages and 37 executable ordinary suite tasks. This is diagnostic evidence, not a performance baseline or a target count.

Verified during planning: `bunx --no-install turbo query affected --help` supports `--tasks`, `--packages`, `--base`, and `--head` on the pinned installation. Do not assume newer online query fields exist without checking the pinned CLI.

## Acceptance criteria

| ID | Observable result |
|---|---|
| AC01 | Ordinary local `--affected` calls without explicit refs retain Turbo-native default comparison, including supported working-tree changes, rather than automatically selecting everything. Explicit valid distinct refs are passed through unchanged. |
| AC02 | Manual workflow execution remains full by default. Existing explicit non-affected commands remain full. Missing history or an unusable explicit range produces a visible full-selection reason; equal explicit refs retain conservative full behavior. |
| AC03 | An owned unit/tooling/integration/recording test-only edit selects its own suite and required prerequisites, but not unrelated suites or consumers. A shared test helper selects every suite that actually uses it. |
| AC04 | A production source, fixture, manifest, generated-input, runner, or runtime/config edit selects all actual consumers, including transitive consumers. Changes with unknown ownership never produce a successful empty selection. |
| AC05 | Impact selection uses real package/task dependencies and scoped external inputs. No dependency, fixture, schema, setup input, or environment sensitivity is removed merely to reduce selected task count. |
| AC06 | Browser selection distinguishes existing feature projects, residual legacy groups, fresh/tunes states, native WebGPU, responsive captures, and Storybook captures. Every existing spec retains one execution owner. Full mode preserves the complete current discovery inventory. |
| AC07 | A docs-only PR with no verification-input changes provisions no browser server, seeded DB producer, Chromium installation, responsive capture, or Storybook capture job. A selected browser group provisions only its required server/seed states. |
| AC08 | Feature-only input edits select the corresponding feature browser project and all actual cross-feature consumers. Conservative package-level fanout is accepted where Turbo cannot distinguish genuine consumers safely. Shared auth, boot, migrations, root composition, harness, or globally consumed style changes select all actual browser consumers. |
| AC09 | Selector command failure, malformed query output, unknown task/project, and inconsistent coverage cannot masquerade as no work. The selector falls back to a complete known execution inventory with a diagnostic when safe; invalid configuration or incomplete inventory fails the job. |
| AC10 | Ordinary deterministic task cache behavior remains correct: identical inputs can hit cache; relevant source, dependency, fixture, manifest, environment, or runner changes miss cache. E2E, capture, and build cache policies are not loosened. |
| AC11 | Actual selected ordinary suites and compiled application browser journeys pass after implementation. Independent verification covers positive selection, negative selection, fallback, caching, inventory parity, and real CI provisioning. Unavailable hosted/hardware evidence remains explicitly blocked. |
| AC12 | The two observed replay WebGPU zoom-transition cases reach their expected stable endpoint without weakening assertions; the affected compiled replay journeys pass. |
| AC13 | Resizing the replay view to mobile updates the telemetry control and panel state as asserted by the existing compiled replay journey. |

## Decisions and implementation interfaces

### Range policy

Keep `scripts/test/run-turbo.ts` as the ordinary CLI entry point. Separate three cases: no explicit refs during ordinary local use; explicit valid distinct refs; conservative full cases. Treat an explicitly empty variable as an unusable explicit value, not the same as an absent variable. If only one variable is provided, preserve Turbo's valid partial-override semantics when the other endpoint can be resolved; otherwise fall back visibly to full.

CI decides mode explicitly. Manual dispatch and main-branch verification remain full by default; PRs use the supplied base/head SHAs. Provide one explicit manual `full` versus `affected` choice, default `full`, with target ref/range validated before affected execution. Keep existing external/reusable callers working: new workflow inputs have conservative full defaults. Do not change GitHub permissions, runners, release jobs, or credentials.

A valid empty affected result is permitted only after successful selection against a trustworthy comparison and complete task ownership. Missing history is not an empty result. Do not replace conservative fallback with a mandatory failure for shallow clones.

### Impact and execution

Use `turbo query affected` for browser/visual provisioning decisions. Query impact tasks, not execution tasks that depend on the shared build. Use real task IDs, not hand-maintained file-to-test maps. Keep root shared infrastructure inputs minimal and retain package-specific external inputs in owning `turbo.json` files with `$TURBO_EXTENDS$` where appropriate.

Reuse catalogue impact tasks. Add side-effect-free impact tasks for existing remaining browser groups in `playwright/turbo.json`; add visual impact tasks there too. Give these tasks scoped `inputs` and actual shared impact dependencies, without inheriting unrelated test execution prerequisites. Configured scriptless tasks are preferred if the pinned query supports them; if not, use the existing executable boundary-check convention, not placeholder/no-op scripts. Confirm this support before changing consumers.

Add `scripts/ci/affected-verification.ts` as the single CLI that converts impact task IDs into workflow selection. It owns the task-to-project/server-state mapping, not source-file matching. It queries the installed Turbo process and performs no builds, app startup, tests, or data seeding. Fixed inventories must be validated against actual Playwright discovery during verification.

CLI contract:

```text
bun scripts/ci/affected-verification.ts --mode <full|affected> [--base <ref> --head <ref>]
```

Success emits exactly one JSON object to stdout; diagnostics go to stderr. The object has required fields:

```ts
{
  mode: "full" | "affected";
  reason: string;
  browserMatrix: Array<{
    name: string;
    serverSet: "fresh" | "tunes" | "tunes-unseeded" | "seeded";
    projects: string[]; // Allowlisted actual Playwright project names.
    shard: string | null; // Existing N/M format; null means unsharded.
  }>;
  seedDatabase: boolean;
  nativeWebgpu: boolean;
  responsive: boolean;
  storybook: boolean;
}
```

Representative cases: known docs-only change => `mode: "affected"`, empty matrix and all booleans false; full mode => complete existing project inventory, seed producer required, both visual jobs enabled. Feature-only tracks change => tracks project plus genuinely affected shared/legacy consumers, seed producer true, unrelated feature projects absent. Do not hard-code an expectation of perfect feature isolation while actual shared dependencies remain broad.

Use JSON output rather than `--exit-code`: Turbo's affected-query exit status 1 means affected work, not failure. Validate field types, allowlists, unique projects, shard consistency, and seed requirements before writing GitHub outputs. Avoid shell interpolation of branch names or arbitrary command fragments; invoke commands as argument arrays.

Retain existing browser projects and setup dependencies. Group selected seeded projects into at most seven shards, using `min(7, selected seeded project count)` to avoid seven jobs for one selected project. Non-seeded states remain separate. Full mode may retain the existing seven seeded shards and current grouping. Native WebGPU remains its existing separate opt-in-capable job. `record-demo` is not a default PR gate and must not become one.

## Scope and ownership

The coordinator owns this plan, selection policy, acceptance decisions, integration, and verification. Implementation workers own source/config/test changes; no commits or desktop control are authorized. Do not start parallel workers without the user's backend choice. An independent checker must not have implemented any changes.

Allowed implementation paths:

- `scripts/test/run-turbo.ts`, `scripts/test/tests/run-turbo.test.ts`.
- New `scripts/test/tests/affected-selection.test.ts`, `scripts/ci/affected-verification.ts`, and selector behavioral tests under `scripts/test/tests/`; register tests in `scripts/test/tooling-files.txt`.
- Root `turbo.json`; existing owner `turbo.json` files and package manifests only to correct real task/dependency edges or classify suite inputs. Keep changes bounded to evidenced consumers. Update `bun.lock` only if workspace manifest changes require it; no dependency version changes.
- `playwright/turbo.json`, `playwright/config/projects.ts` only if needed to share existing project identifiers without changing discovery semantics; shared inventory must remain side-effect-free.
- `.github/workflows/build-test.yml`, `playwright-e2e.yml`, `playwright.yml`, `pr-visuals.yml`, `pr-screenshots.yml`, `pr-snapshots.yml` and necessary existing callers of their changed inputs.
- Root `package.json` only for a documented full verification entry point if existing commands cannot express full mode; preserve existing full `test`/`test:all` behavior.
- `scripts/README.md`, `test/README.md`, `docs/contributing/e2e-testing.md`, and one `CHANGELOG.md` entry for the coherent change.

Out of scope: deleting or rewriting product tests from the audit; feature/package extraction; unrelated application behavior or public contracts; replacing Bun/Playwright; enabling remote caching or E2E result caching; caching currently uncached builds; changing runners, permissions, release topology, or hardware requirements; making every feature perfectly isolated by hiding real dependencies. Product changes necessary to fix the observed replay WebGPU zoom-transition and mobile telemetry state failures are authorized.

## Implementation order

### 1. Establish behavioral selection fixtures and fix range handling

Extend existing runner tests, using their subprocess pattern. Add isolated Git/workspace fixtures with a leaf, consumer, unrelated owner, shared helper, and distinct suite manifests. Exercise the real wrapper and real installed Turbo; do not mock Turbo output as the only proof. Never create commits or mutate branch refs in the user's checkout; fixture history and edits belong in temporary repositories/worktrees. Cover local defaults, uncommitted changes, valid explicit/partial ranges, equal refs, invalid refs, and missing history.

Separate default-local assertions from retained manual/full assertions. Remove overlapping equal-ref tests only after one clear behavioral case preserves the required fallback. Gate: E01–E03 pass; other behavior is unchanged.

### 2. Scope ordinary suite inputs without losing transitive coverage

For each inherited domain-file list, identify actual consumers and move the input to their owning configuration or express its real workspace dependency. Retain shared runner/SCM/config inputs globally where genuinely consumed. Split suite-specific tests, manifests, helpers, and fixtures from production transit. Keep `$TURBO_DEFAULT$` unless a demonstrated need justifies an explicit complete input set. New tests must be included automatically through scoped globs or generated inputs derived from authoritative manifests, not a second hand-maintained list.

Approved scope change: derive suite-specific Turbo inputs from the authoritative ownership manifests using generated configuration. The generated configuration must stay synchronized automatically, include newly owned tests, preserve shared inputs and cache sensitivity, and fail closed when ownership or generation is invalid. E04–E07 must exercise the generated configuration through the real wrapper and Turbo. The implementation may add the minimal generator and its tests under `scripts/test/`, and update callers and documentation required to use it.

Do not exclude a test helper/fixture from transit until owning suite inputs explicitly retain it. Keep theme/design-source consumption in the tooling owner. Include lockfile/external dependency and existing environment sensitivity. Gate: E04–E07 selection and execution evidence passes before removing old broad inputs.

### 3. Implement browser/visual impact selection

Reuse feature impact tasks; add remaining groups and visual impact tasks without duplicating spec ownership. Derive actual shared input closures from existing projects/server/seed/build helpers and architecture contract. Implement the CLI contract above. A shared seed helper change selects its consumers even though seed execution occurs later.

User-approved precision change: retain conservative package-level fanout when the package graph cannot safely distinguish transitive consumers. Fresh and tunes have genuine tracks consumers. Do not remove those edges or introduce a hand-maintained file-to-test map. E08 must still demonstrate a real feature change that excludes at least one unrelated feature.

Gate: E08–E10 passes, including full discovery parity. Diagnose and fix the observed replay WebGPU and mobile telemetry failures without weakening their assertions; product changes necessary for those fixes are authorized. Verify AC12 and AC13 using E14 and E15 before completion.

### 4. Gate workflows before heavy provisioning

Add a lightweight planning job after checkout and pinned Turbo availability, before browser builds, Chromium installation, and database preparation. It may install required tooling; it must not provision application runtime merely to decide impact. Reuse validated PR SHAs and enough Git history. Feed its JSON-derived outputs into browser/visual reusable workflows. A seed producer runs only when selected seeded/native groups require it; fresh/tunes-only selection does not depend on a skipped seed job.

Protect against GitHub's skipped-`needs` propagation: browser rows that do not need seeding must remain runnable, while rows needing a failed seed cannot pass. No empty matrix expansion, fake successful capture, or artifact download for skipped producers. Preserve expected branch-protection check names, or use one stable aggregate verification job that explicitly fails if selection or any required child fails; do not use unconditional success to hide failures. Existing manual/reusable callers default to full mode. Update all affected reusable callers and documentation together.

Gate: E11–E13 on actual hosted workflows. Local parsing or mocked GitHub output does not prove jobs were skipped.

### 5. Verify real execution and independent review

Run ordinary selected suites, compiled browser journeys, and full discovery parity. Test cache hit and invalidation with a temporary local cache and controlled environment, without enabling browser/build caching. Update docs and changelog once. Independent checker repeats affected cases from the final source and reports commands, selection, actual execution, hosted job results, and unavailable evidence. Corrective edits return to an implementation worker and invalidate affected verification.

## E2E and edge-case verification matrix

Selection is a system entry point: tests must invoke the real wrapper/selector and real Turbo in isolated Git workspaces. Query/dry-run evidence proves selection only; the corresponding execution scenarios prove the selected tasks actually run. Use existing Bun tooling tests and Playwright suites; do not introduce another runner.

| Scenario | Setup and action | Observable expected result | Criteria |
|---|---|---|---|
| E01 | Fixture with a known branch-base difference; remove both SCM variables; invoke real `run-turbo.ts ... --affected --dry=json`, then execute selected leaf suite. Repeat with modified and untracked relevant test/source files as supported by Turbo 2.11.7. | Native local selection includes relevant committed/working changes; unrelated owner absent; leaf assertion executes. No automatic full fallback just because variables are absent. | AC01, AC03, AC11 |
| E02 | Invoke wrapper with distinct valid refs, a valid single override, invalid refs, an explicitly empty ref, equal refs, and shallow/missing comparison history. | Valid native overrides retain selection; unresolved/equal explicit ranges execute full requested graph with visible reason. A query error is never treated as empty. | AC01, AC02, AC09 |
| E03 | Invoke existing full root commands or their selection entry point; manually dispatch workflow with default/full mode and with explicitly requested affected mode. | Full remains full even on equal/no-difference refs; affected mode uses validated range; required gates are not lost. | AC02, AC06, AC11 |
| E04 | In isolated fixture and one real owner, edit a unit test, then integration test, then tooling test, then recording test; edit the corresponding suite manifest. Query and run affected suite tasks. | Only owning suite plus prerequisites executes for each edit; no accidental transit fanout. Manifest changes affect owning suite. | AC03, AC05, AC11 |
| E05 | Edit a shared test helper, an owned fixture, and production leaf code with a transitive consumer and unrelated owner. Include fixture addition/deletion/rename. | All actual direct/transitive consumers selected; non-consumer absent; selected real behavior assertions pass. Fixture matching does not depend on old filename only. | AC03, AC04, AC05 |
| E06 | Edit common runner, root test config, dependency manifest/lockfile, and a relevant task environment variable in isolated state. Add a new test under existing ownership. | Correct consumers selected/cache-invalidated; new test discovered by manifest guard and owning task input; unknown ownership fails validation or selects full coverage, never silent omission. | AC04, AC05, AC09, AC10 |
| E07 | Execute deterministic affected tasks twice with temporary local cache; change relevant input/env, then unrelated non-input. | Second identical run reports cache hit; relevant change misses and actually executes; unrelated change does not invalidate unrelated tasks. No E2E result-cache enablement. | AC05, AC10, AC11 |
| E08 | Controlled tracks-only, cars-only, and another existing feature input change; invoke selector, then list and execute returned projects against real compiled app. | Owner and actual cross-feature consumers selected; at least one unrelated feature excluded in a real leaf case. Conservative package-level fanout is allowed. Real API/data-backed feature journeys pass. | AC06, AC08, AC11 |
| E09 | Edit auth/startup/schema/migrations, shared seed/harness, root routing/composition, or global style inputs. | All actual consuming groups/visuals selected. Backend-only non-rendering input may conservatively select residual legacy coverage; no unsafe empty result. | AC04, AC05, AC08 |
| E10 | Full selector output plus real `playwright test --list`; compare union of selected project/spec ownership with pre-change full inventory, including setup and native groups. Inject query process failure, malformed JSON, unknown task/project and incomplete inventory into isolated test process. | Every prior spec remains discoverable once per intended project; no accidental `record-demo`. Safe query uncertainty selects full with reason; invalid inventory fails clearly. | AC06, AC09 |
| E11 | Hosted PR with docs-only non-input change; inspect planning outputs and workflow jobs. | Selection succeeds empty; no browser/seed/Chromium/responsive/Storybook jobs provisioned. Stable required aggregate succeeds because no relevant work exists, not because failure was ignored. | AC07, AC09, AC11 |
| E12 | Hosted controlled feature PR and fresh/tunes-only harness scenario, then shared-runtime PR. Inspect actual jobs/artifacts and execute real selected browser journeys. | Only selected matrix/server states provisioned; no seeded producer for fresh/tunes-only; selected seeded/native groups receive seed. Shared-runtime change runs all consumers. Selected failure makes aggregate fail. | AC06, AC07, AC08, AC11 |
| E13 | Hosted manual full dispatch and reusable workflow invocation without new inputs; separately force selector/seed/browser/capture failure in controlled branch. | Default full inventory retained. Failed prerequisite is not successful no-work; no skipped producer artifact is requested; affected checks accurately fail. | AC02, AC09, AC11 |
| E14 | Run the compiled replay WebGPU zoom-transition cases for FM 2023 and F1 2025 after the fix, then rerun the affected replay journey. | Both cases reach the asserted stable zoom endpoint and the affected journey passes without weakening assertions. | AC11, AC12 |
| E15 | Execute the compiled replay telemetry/preferences journey, including desktop-to-mobile resize, after the fix. | The telemetry button and panel report the expected collapsed state on mobile; the complete affected replay journey passes. | AC11, AC13 |

Timing waits must observe deterministic task/job state, not arbitrary sleeps. Use existing committed recordings and isolated DATA_DIR/ports for real application runs. Browser tests must use real compiled UI/backend integration; mocks may control unrelated external services but cannot replace application paths under validation.

## Commands and completion gates

Existing commands:

```sh
bun run test:shards
bun test ./scripts/test/tests/run-turbo.test.ts ./scripts/test/tests/affected-selection.test.ts
bun run test:tooling
bun scripts/test/run-turbo.ts typecheck lint --affected
bun scripts/test/run-turbo.ts test:unit test:tooling test:integration --affected --dry=json
bunx --no-install turbo query affected --tasks e2e:impact --base <base> --head <head>
bunx --no-install turbo run test:e2e --filter=@raceiq/tracks-catalogue
bunx --no-install turbo run test:e2e --filter=@raceiq/cars-catalogue
```

`affected-selection.test.ts` is a planned new entry point, not an existing test. Run the selector's additional registered behavioral tests through `test:tooling`. During verification load only the relevant Playwright spec/config for selected groups. Extend the existing invocation with the affected replay/session/analyse projects as required by E08/E09; do not claim catalogue-only execution covers those groups.

Run the real new selector for full, known-empty, feature, shared, and fallback cases; validate its output against actual discovery. Use explicit known refs in CI-style scenarios and clear inherited SCM variables in native-local scenarios. All commands must exit successfully except intentional failure cases, whose exact nonzero outcome must be asserted.

Completion requires passing evidence for every AC and E01–E15, plus independent checker evidence. Record concise results in this plan's execution status; do not create routine log/evidence files. Hosted CI, manual dispatch, and native WebGPU require authorized runners/environment. If unavailable, finish reachable work but leave the affected scenarios blocked and do not mark implementation complete.

## Execution status

- Range handling, generated suite inputs, browser selection, workflow gating, documentation, and the authorized replay fixes are implemented. Independent checks verified fail-closed ownership for client and hidden ordinary tests.
- `bun run test:shards` passed. `bun run test:tooling` passed after the final fixture correction: eight tasks successful, including 86 tooling tests. Independent affected-selection checks passed 17 tests and 148 assertions. A real-owner task execution demonstrated a cache hit.
- `bun scripts/test/run-turbo.ts typecheck lint --affected --concurrency=2` passed 82 tasks. Playwright discovery listed 306 tests; selector inventory checks passed.
- Compiled tracks and cars catalogue journeys passed. The replay suite passed after the fixes: 45 passed, with one cold-frame assertion passing on retry. Independent replay checks passed three targeted browser scenarios; the resize-before-effect race remains without direct proof.
- A tracks change selects additional browser projects through genuine package dependencies. Fresh and tunes consume tracks; conservative package-level fanout is authorized.
- Hosted CI provisioning, manual dispatch, branch protection, and native-hardware WebGPU remain unverified. `actionlint` is unavailable. No completion claim is made.

## Stop conditions and maintenance

Stop for approval if correctness requires application/package extraction, deletion of tests, product behavior changes beyond the authorized replay fixes, different runner permissions, or toolchain upgrades. A false-negative selector is a release-risk defect: restore conservative coverage before narrowing further. Do not chase lower task counts by removing genuine dependencies. Unknown file ownership must fail closed to full verification or a visible configuration failure.

Keep project identifiers and server-state mapping synchronized with Playwright discovery. New suite helpers/fixtures must update the owning task inputs and positive/negative selection scenarios. Changes to selection semantics require the same updates to acceptance criteria, implementation steps, and E2E cases. No remote-cache provisioning, new dependency, or skill installation is needed.
