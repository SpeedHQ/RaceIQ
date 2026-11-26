# Catalogue package impact contract

Status: approved; hosted acceptance pending.

Plans: [UI](catalogue-package-impact-ui-plan.md), [backend](catalogue-package-impact-backend-plan.md). Decision: [ADR 0017](../../adr/0017-catalogue-package-impact.md). Existing authority: [feature package contract](../../architecture/feature-packages.md) and [ADR 0016](../../adr/0016-task-level-affected-verification.md).

## Boundaries

- Keep `@raceiq/cars-catalogue` and `@raceiq/tracks-catalogue` as the feature workspaces, including their server, UI and Playwright projects. Keep the project IDs `cars-catalogue` and `tracks-catalogue`. Do not split Tracks list from detail, extract Home or Experiments, move the entire UI library, or change cache, runner, shard or full-mode policy.
- Preserve browser URLs and typed Hono RPC. The existing `CarsCatalogueHost` and `TracksCatalogueHost` in `packages/{cars,tracks}-catalogue/contracts/host.ts` and `trackRoutes`, `carRoutes`, `accCarRoutes`, `acEvoCarRoutes` mounted in `apps/backend/src/routes/index.ts` remain authoritative. No change to request/response types, headers, error behavior, ordering, nullability, permissions, or route precedence. For example, `GET /api/cars` still takes `X-Game-Id`, and `GET /api/tracks?gameId=f1-2025` still returns the list with outline availability and lap counts. Preserve Tracks detail reads, import/deletion and capture-ready behavior. Global DB connection, write coordination, schema and migrations stay authoritative in the platform.
- `@raceiq/<feature>#e2e:impact` identifies changes that can affect the feature. Turbo follows declared workspace/task edges and file inputs. Keep only explicit app-owned seams (route registration, host adapters and shared runtime) as inputs outside package ownership. Do not grow a list of excluded pages or add a second selector. The compiled app and seeded DB are execution prerequisites, not blanket impact edges. Keep shared auth, route mounting, boot, persistence, harness and assets covered; unverified ownership fails closed under the existing selector.
- Keep real dependencies, even when they spoil a skip. In particular Tracks' compiled-app suite exercises recorded-lap import/delete and capture readiness. If the exact #542 recorder diff reaches that contract through a verified dependency, select Tracks and record the edge; do not exempt the recorder path. Cars must skip it if it does not change car discovery, metadata or common behavior. Unknown closure, undeclared inputs, or a proposed broader extraction are implementation blockers, not grounds to drop coverage.

## Implementation ownership

After approval, UI and backend can migrate independently against the unchanged host/router contracts. UI owner edits UI/host sources; backend owner edits server sources. The integration owner alone changes package manifests, `bun.lock`, `turbo.json` files, selector fixture expectations, common docs and release notes. Owners submit required package exports and task edges to integration. Manifest and lock changes can legitimately force full selection on the extraction PR; test subsequent content-only diffs against a branch that already contains the migration. No hosting or push implied by plan approval.

## Acceptance and end-to-end evidence

Use branches at the same migrated base, one controlled diff at a time. Exercise the real selector (`bun scripts/ci/affected-verification.ts --mode affected --scope pr --base <base> --head <head>`) through the existing `scripts/test/tests/affected-verification.test.ts` Git/Turbo fixture. For hosted confirmation, use approved PRs targeting a base with the migrated configs and project rules. Inspect `Select verification jobs` output, seeded matrix project args, and `Verification` conclusion; cancellations or prerequisite failures do not prove a project was skipped. Use isolated committed seed data and the existing compiled-app Playwright runner, not a fake catalogue API. The integration owner records commands, run URLs, observed matrix and browser results after implementation.

| ID | Setup and action | Required observation |
|---|---|---|
| CAT-1 / E1 | Separate Home and Experiments UI/route-only diffs, including an added page-owned UI file | Both catalogue IDs absent; build and other affected coverage remain. No Home/Experiments exclusion patterns remain. |
| CAT-2 / E2 | Change each catalogue's own UI and API in separate diffs; change actual shared UI consumed by both | Owning catalogue selected; the peer runs only for a verified shared dependency. Shared UI selects both. Run selected catalogue against the compiled app; search, sorting, navigation and its real API data pass. |
| CAT-3 / E3 | Replay #542's recorder diff; separately change discovered-car reads, Tracks lap counts, and a recorded-lap read used on track detail | Recorder diff skips Cars; Tracks skips it only if the proven closure permits. Discovery change selects Cars; lap data changes select Tracks. Run the affected compiled detail and import/delete scenarios. |
| CAT-4 / E4 | Change shared boot, API auth/registration, DB schema or seed setup in isolation; delete or move an owned input | Shared inputs select both; deletion still uses base ownership and a move selects both actual owners. Run selected browser suites with isolated seed DB. |
| CAT-5 / E5 | Use invalid, equal, shallow/missing-history or unclassified input cases covered by the selector; dispatch existing full verification through an authorized environment | Full inventory or the existing visible hard failure for a malformed plan. Full browser invocation still discovers and runs both catalogue projects. No green empty result from unverified impact. |
| CAT-6 / E6 | Build and run the compiled app with both catalogue projects, plus existing affected cross-feature journeys reported by Turbo | Existing API behavior, UI and browser tests remain intact. No server code in the client bundle, no duplicate specs, no renamed projects. |

Verification commands include `bun test scripts/test/tests/affected-verification.test.ts`, `bun run typecheck`, and `bunx --no-install turbo run test:e2e --filter=@raceiq/cars-catalogue --filter=@raceiq/tracks-catalogue --concurrency=1`. Extend the actual selected Playwright command for affected cross-feature journeys. Record skipped projects separately from avoided runner jobs: other seeded projects can still keep all seven shards. Hosted environment or runner unavailable means affected criteria remain unverified.

## Execution evidence

- Local selector, Cars route, Sessions identity-repair and changelog regressions passed: 37 tests. The real Git/Turbo fixture exercises the changed-path set from #542 and confirms that Cars is absent and Tracks is present.
- Explicit full and invalid-ref selector runs both produced 10 matrix rows with both catalogue projects. Frozen offline install and workspace typecheck passed.
- Compiled application Playwright passed: Cars 6, Tracks 7, including recorded-lap import/delete.
- Hosted matrix, manual dispatch and additional hosted cross-feature journeys remain unverified. No commit, push or validation PR was authorized.
