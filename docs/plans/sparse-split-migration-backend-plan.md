# Backend: sparse split startup migration

Contract: [shared boundary and acceptance](sparse-split-migration-contract.md). UI: [parallel UI plan](sparse-split-migration-ui-plan.md).

## Scope and tasks

Own backend startup split recovery, split-manager admission, authenticated storage routes, and backend regression coverage. Reuse `server/db/session-queries.ts` eligibility and verified publication. Capture eligible startup membership before admission; hold only that membership for explicit consent, not imports/new live sessions. Seed jobs already queued must be included. Expose status/start endpoints from shared contract. Derive completion from durable jobs; make retry explicit for failures. Preserve folder relocation maintenance locking and current capture source integrity.

## Edge handling

Startup queued/interrupted work waits for consent (AC1/5); current-run imports remain independently eligible (AC3). Completed publications drop out on restart (AC2/4). Missing files, invalid lap windows, non-BIN sources, live epochs and indexed captures are excluded using existing authoritative eligibility (AC4). Duplicate start is idempotent; failures retain unfinished membership and a visible outcome (AC5). Folder migration defers execution until safe (AC4).

## Verification

Extend existing split lifecycle/route integration tests for held startup jobs and current-run imported jobs. E2E owner is main agent: isolated DATA_DIR seeded normally with one real fixture; launch actual backend, GET idle status, verify no archive before consent, POST consent, poll published DB/API state and independently replay selected lap (AC1/2). Import sparse capture through `/api/laps/import` while startup consent pending and observe ready split publication (AC3). Empty/ready startup and reload status cover AC4/5; exercise controlled failure/retry and duplicate POST where harness supports it. Run focused existing integration tests and `bun run typecheck`. Unexecuted scenarios are reported, not treated as passing.

## Physical-file implementation phase

The [physical cutover contract](sparse-split-migration-contract.md#physical-per-lap-cutover) supersedes archive publication expectations above.

ADR: [Package-owned splitting and physical-file clarification](../adr/0011-package-owned-indexed-capture-splitting.md).

1. Package owner: change the completed-session writer to bounded sequential physical `.bin` writes and manifest v3, sync each file, independently verify source conservation and selected-file semantics before manifest publication. Preserve sparse checkpoints/bootstrap/context. Update package-owned and six-game splitting expectations to assert actual file existence and independent replay (PL1/2/6).
2. Backend owner: publish directory layout 1 with a null archive reference; migrate layout-2 sessions through existing fenced split jobs while leaving old publication readable until commit. Include old bundles in startup consent; current-run imports remain automatic. Update readers, replay/export, cleanup, relocation and backend regression expectations as required. Do not enable the release-gated incremental live recorder (PL3/4/5).
3. Main integration owner: run real app startup and import through HTTP against isolated six-game sparse seeds; enumerate manifest lap paths, assert one distinct physical file per DB lap and no new session bundle. Replay/export a selected lap through production routes, import its exported recording into the running application, and observe physical files for the imported session. Seed or restore a genuine v4 bundle fixture, boot, confirm consent and old replay availability, then consent and assert atomic layout-1 publication. Exercise filesystem failure/retry and moved-source recovery; run applicable package/game/backend gates and full typecheck (PL1–6).

### Boundary and failure handling

Lap 0 is non-negative, not renumbered (PL1/2). Invalid/incomplete persisted windows remain represented rather than dropped (PL1). Context is non-owned and may be repeated only as required for independent decoding; auxiliary files conserve source frames not owned by laps (PL2). Missing canonical source prevents rebuilding an old bundle: preserve its readable publication and report the unavailable migration prerequisite, never clear references or synthesize telemetry (PL3/5). Interrupted attempts remain staged and invisible; source revision changes fence old work and retry derives current paths (PL5). Physical file paths remain relative, contained, unique, and regular; corrupt/missing files fail visibly rather than falling back to whole-session playback (PL2/5).

E2E evidence must distinguish physical file count, actual selected-lap replay/export, and startup migration from unit-only or logical chunk assertions. Existing runtime harness and fixture conventions are reused; temporary scripts are removed after verification.
