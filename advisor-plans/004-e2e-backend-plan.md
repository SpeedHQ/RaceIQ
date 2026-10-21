# Plan 004: Extract dashboard backend ownership, then isolate game replay

Status: TODO / PROPOSED. Dashboard pilot priority P2 after conservative CI gating; recording pipeline follows as a separate milestone. Effort L. Risk high: stateful telemetry and host-side effects.
Planned at `4eef7739c`, 2026-10-21. No implementation or commit authorization.

Shared authority: [contract](002-e2e-extraction-contract.md). ADR: [decision](../docs/adr/0015-e2e-aware-package-extraction.md).
Counterparts: [CI/integration owner](003-e2e-selection-plan.md), [independent UI owner](005-e2e-ui-plan.md).

## Why and current state

Game packages already exist. Their physical dependency on `@raceiq/backend-core` makes unrelated backend changes affect game replay tasks. Moving more files without removing that dependency does not solve this.

Evidence:

- `packages/game-acc/src/index.ts:2-9` uses server adapter contracts, lap detection and AI prompt schema/context from backend core. Its `processors.ts`, `replay.ts` and `shared-memory.ts` also use core processing/native services. `packages/game-acc/package.json:6-10` declares the broad edge.
- `server/games/types.ts:30-75` mixes parsing/checkpoints/runtime/detector requirements with `aiSystemPrompt` and `buildAiContext`.
- `server/lap-detection/detector.ts:15-34` combines existing telemetry-core detector engines with metrics persistence, experiment exclusions, track storage/lookup and logging. It cannot be moved unchanged into a pure foundation package.
- `server/telemetry/live-pipeline.ts:1-19` mixes neutral normalization/processing with host registry and calibration; `pipeline-ports.ts` is the existing DI seam.
- `server/ai/schemas.ts:14-17` imports setup validation/catalog behavior. A nominal prompt schema import is not necessarily a leaf dependency.
- `apps/backend/src/games/init.ts:1-8,23-50` composes every game and registers adapters; this remains the application composition root.
- `apps/backend/test/support/setup-app.ts` registers all games, MoTeC and profile notifier. `scripts/test/run-suite.ts:57-60` applies this only to backend/frontend-contract owners, while every non-unit owner also receives data-dir setup. Preserve appropriate application setup while avoiding new all-game preloads in individual game owners.

## Scope and ownership

Own proposed `packages/game-runtime-contracts/`, `packages/recording-pipeline/`, game runtime/parser/replay/analysis composition changes across existing six `packages/game-*/` implementations, corresponding game tests/manifests, `server/games/`, `server/lap-detection/`, `server/live-strategy/`, `server/telemetry/`, affected host side-effect adapters, and `apps/backend/src/games/` composition. Own new browser-safe DTO declarations needed by the UI plan in existing `shared/` domain modules; UI owner migrates client consumers, never edits those declarations concurrently.

The first vertical slice additionally owns `packages/dashboard/server/`, backend unit/integration tests within that same feature package, `apps/backend/src/routes/dashboard-routes.ts`, feature-owned dashboard queries currently under `server/db/`, and `server/session-capture/dashboard-processor.ts`. Backend owner supplies agreed bindings in `packages/dashboard/contracts/`; UI owner controls `ui/`, CI owner controls feature manifest/exports/configuration and `test/e2e/`. Shared DB schema/migrations/connections/write coordination remain platform-owned. Integration owner manages host boot/route registration edits; reconcile overlapping plan 001 work before relocation.

Shared `server/package.json`, root lockfile/TypeScript references and root task inputs have one integration editor. Coordinate changes with CI owner; package-local input definitions belong to this plan. Update architecture/contributor docs after proof.

Out of scope: changing capture formats, migrations, detector decisions, native source semantics, settings, API values, AI recommendations, scheduling policy or UI behavior. Existing algorithms in telemetry-core, analysis-core, capture-formats/splitting/downsampling must be reused, not extracted again or copied.

## Tasks and dependency order

### B0. Extract the dashboard backend pilot

Follow the shared contract's vertical feature boundary and unchanged HTTP/WS operations. Move the Home dashboard router, dashboard-specific query/reduction/publication services and processor into `packages/dashboard/server/`, exposed as `@raceiq/dashboard/server`. UI, contracts and E2Es remain in the SAME `@raceiq/dashboard` workspace, not sibling layer packages. Preserve exact types, semantics and transitions. Keep general session/lap CRUD, migrations and DB connection ownership platform-owned. Bind real DB executors, catalog/name resolution, notifications and lifecycle scheduling without reverse imports into `apps/backend` or feature UI.

The shared DB platform may conservatively remain a backend-core dependency initially: changes there still select all real consumers. Remove feature implementation from backend-core so a dashboard-only implementation change no longer mutates that shared package. Invert any existing shared-core import of dashboard implementation at application composition; no backend-core → dashboard → backend-core cycle. The feature manifest declares both browser and backend dependencies honestly; scoped exports/import-boundary checks, not hidden dependencies or a mixed root barrel, keep backend code out of the browser.

Export real typed Hono routes/factory through `@raceiq/dashboard/server` for existing `.route()` composition; preserve `AppType` inference. Put feature host-binding interfaces in agreed `contracts/` exports; existing genuinely shared API DTOs retain their authoritative source. Move exclusively dashboard tests into this feature's unit/integration directories; cross-feature storage/write coordination remains with its integration owner. Run server-scoped typechecking and the AC-12 import-boundary gate, proving server code never imports UI and browser consumers never load this entry.

Acceptance: AC-08/11/12 through E09/E10. Dashboard UI/backend/spec-only changes select dashboard, app smoke and actual cross-feature consumers; unrelated tuning/recording suites do not run merely because the app is rebuilt. Real compiled Home/API/SQLite/WS scenarios preserve mine-only totals, periods, null/empty/pending/error/recovery, recap navigation and post-write refresh. Existing dashboard unit/query tests supplement this proof, not replace it. Run the final shared selector/full discovery gate with CI owner.

This pilot and the UI pilot may run in parallel after contract approval. Complete and verify the pilot before starting the later game-runtime extraction milestone; do not make the vertical feature work wait for a full pipeline redesign.


### B1. Establish baseline and exact import/reference map

Use language-server references before relocating exported contracts. Enumerate runtime/type imports for all six game workspaces, replay helpers and test setup; account for relative imports and package subpaths. Capture actual fixture assertions and persisted results through existing isolated game/application E2Es. Record failures and unavailable platforms without relabeling them as extraction regressions.

Review shared contract and applicable Effect guidance before changing any Effect-owned lifecycle code; prefer leaving lifecycle code host-owned. Preserve the invariants in `docs/reference/semantics.md`, `docs/architecture/overview.md` and `docs/contributing/scheduled-recording-maintenance.md`.

Verify: existing isolated recording gates produce a known baseline, `bun run test:shards` preserves ownership, and controlled selection E03–E05 exposes current over-selection. Tests are implementation work, not part of this planning session.

### B2. Extract neutral game runtime contracts

Create private source-export workspace `@raceiq/game-runtime-contracts`, matching existing package script/export/tsconfig conventions. Move only runtime-neutral interfaces/types from `server/games/types.ts`, `server/lap-detection/types.ts` and `server/telemetry/pipeline-ports.ts`; split mixed implementation pieces instead of importing them back from backend core. Reuse shared semantic types rather than duplicate them.

Separate analysis extension from runtime adapter contract. Host-side composition supplies real analysis behavior; all analysis callers remain statically typed. Migrate every caller and remove obsolete exports/forwarders in the same coherent cutover. Add boundary checks prohibiting backend/client/DB/AI-runtime/concrete-game imports. Do not keep compatibility re-exports solely to avoid updating callsites.

The UI plan needs authoritative shared types for existing driver profile and recording-directory DTOs; move declarations, not server implementations, to existing shared domain files and communicate exact exports before client migration. Preserve field optionality/nullability and inferred HTTP shape.

Verify: affected package/backend/client typechecks, existing adapter registration tests, E05 selection, and fixture smoke. This phase alone may not reduce game E2E selection: the implementation still depends on backend core until B3/B4.

### B3. Extract neutral recording pipeline, using existing ports

Create private source-export `@raceiq/recording-pipeline`. Move neutral live packet processing, detector orchestration, sector/pit tracking and shared replay/Kunos processing used by game owners into it. Keep core engines in telemetry-core. Keep platform memory readers and platform timer handling in appropriate game/native host modules, not in contracts or browser imports.

Remove direct dependencies on metrics persistence, experiments, filesystem trace/curb storage, track calibration/lookup, mutable host registry and global WebSocket/logging state by binding existing production implementations through the port seam. Preserve callback ordering, shared mutable state ownership, native parser checkpoint behavior and per-packet allocation characteristics; do not add unnecessary object copies, async hops or generic service frameworks.

Production host supplies real callbacks; game fixture E2Es use existing capturing adapters where appropriate. Preserve application/DB E2Es to prove the real persistence path; a capturing adapter is not a substitute. Do not inject no-op production fallbacks or silently omit notifier, calibration, metrics or exclusion behavior. Preserve worker/lifecycle/write-lease ownership and shutdown ordering; storage maintenance remains backend-owned.

Verify: E04/E05 real replay proves exact frame/lap/sector/classification equivalence; E07 proves SQLite writes and notifications through the compiled application. Exercise startup, recording and shutdown using isolated DATA_DIR and existing application E2Es. If native readers move, require supported Windows capture proof; otherwise keep native reader implementations unchanged and disclose replay-only evidence.

### B4. Move game analysis composition out of replay dependency closure

Split game prompt/context bindings from runtime adapter entry points. Host statically imports and composes both, preserving every actual game prompt and setup-validation behavior. Keep schemas in one authoritative location; extract a true schema-rendering leaf only if required, not a copy. No dynamic imports to break cycles.

Rebind game replay/native helper imports to neutral contracts/pipeline. Remove `@raceiq/backend-core` from each game manifest only after its last runtime AND type dependency is migrated. If replay still needs core, the boundary is unfinished; do not erase the manifest edge to make Turbo appear selective. If host dependencies remain unavoidable, isolate that host integration in a separate workspace rather than pretend subpath exports have independent package dependency graphs.

Backend app composition may legitimately depend on all games. Keep it broad; individual game replay owners must register only the games they need. Maintain a separate all-game application gate. Do not alter broad application tests to become single-game tests to claim isolation.

Verify: E03 prompt-only changes no longer select game recording tasks; E04 ACC changes no longer select unrelated game replay owners; E05 shared processing selects all consumers. Execute corresponding real suites and compiled browser analysis/chat/replay paths. Relevant provider-independent schema/prompt tests supplement browser integration; no paid AI requests required.

### B5. Narrow test ownership and inputs; retain cross-feature E2E

Reuse existing per-game `test/e2e-files.txt` manifests. Leave genuinely application-owned UDP, import/export, classification migration, dashboard write coordination and DB upgrade tests in backend ownership (`apps/backend/test/e2e-files.txt`); these tests may validly run across multiple feature changes. Do not create a fake parser package around an application test or delete coverage.

Provide CI owner exact external fixture/setup inputs for each replay owner, replacing inherited blanket implementation lists only after graph coverage exists. Remove accidental localization dependency from recording E2Es that do not import client code; retain it for frontend-contract tests where the actual test uses the client. Test-support dependencies are real dependencies.

Run final E03–E08 with CI/UI integration. Update architecture boundaries, contributor commands and the shared Internal changelog note once inputs stabilize.

## Acceptance, edge cases and E2E evidence

Owned criteria: AC-03/04/05/08/11/12; shared completion: AC-02/07/09/10. Contract E03/E04/E05/E07/E09/E10 provide exact setup/action/assertions; E08 validates DTO consumers with the UI owner. All must be covered by passing real-system evidence before marking this plan DONE.

Specific handling:

- Stateful F1/iRacing checkpoints and out-of-order/missing packets: preserve existing parser state/checkpoint contracts and existing recorded boundary/reset cases; validate cold replay, not only warm caches (AC-08, E04/E05/E07).
- ACC/AC Evo shared pipeline: changes to their shared neutral processing select both consumers; an ACC-only parser fixture must not imply the other game changed (AC-04/05, E04/E05).
- Lap completion side effects: preserve real DB transaction, metrics, exclusions, notifier/WS and track-write behavior through production host adapters, including failures and shutdown (AC-08, E05/E07).
- Feature flags and registry initialization: preserve enabled/disabled iRacing behavior and no implicit fallback game; test isolated single-game registration plus application all-game composition (AC-07/08, E04/E07).
- AI composition still consumed by full application: browser E2E remains selected for prompt changes even when recording tasks are skipped (AC-03, E03).

## Commands after implementation

| Command | Expected result |
| --- | --- |
| `bun run test:shards` | Existing coverage retained, no duplicate/missing ownership. |
| `bun scripts/test/run-turbo.ts test:e2e:recordings --filter=@raceiq/game-acc --force` | Existing ACC recorded fixture assertions pass. Repeat for each changed game with its actual name. |
| `bun run --cwd apps/backend test:e2e:recordings` | Application-owned recording E2Es pass with real DB integration. |
| `bun run --cwd server test:integration` | Core host integration preserved. |
| `bun run typecheck` and explicit new-workspace typechecks | Exit 0; no lost exported callers. |
| `bun run lint` | Exit 0. |
| `bun run build` | Existing production client/server binary builds. |
| `bun run test:e2e` | Compiled app/browser integration passes. |

Use selector E03–E05 output as scheduling evidence, never substitute it for the commands above. Record exact commands/results/platform with the CI integration owner. Full final runtime acceptance is a shared dependency, not a reason to serialize independent UI edits.

## Stop conditions and maintenance

Do not publish a package with a cycle into backend core, copied algorithms, no-op callbacks or hidden application initialization. If neutral processing cannot be isolated without changing behavior, stop that extraction and retain conservative selection; report the exact edge and design decision required. Do not broaden this task into DB, Effect or native-source redesign.

Future game implementations depend on contracts/pipeline and their own metadata, never the application composition root. Add positive/negative E2E selection coverage when changing a manifest, preload or registry binding. Package subpaths do not provide independent Turbo invalidation when their parent manifest still carries broad dependencies.
