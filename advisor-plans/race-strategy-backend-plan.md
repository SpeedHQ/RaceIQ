# Race strategy server extraction plan

Contract: [race-strategy-contract.md](race-strategy-contract.md). UI plan: [race-strategy-ui-plan.md](race-strategy-ui-plan.md). Follow [feature packages](../docs/architecture/feature-packages.md).

Execution: shared server integration scenarios passed, including automatic startup reconstruction, unsafe-source isolation, restart stability and admitted-work shutdown. See the contract's [execution results and explicit limitations](race-strategy-contract.md#execution-results) for final evidence and the four broader recording assertions that remain failing.

## Scope and ownership

Own `packages/race-strategy/server/`, server-specific host contracts/neutral platform ports, feature route groups, backend feature app composition, and exclusively owned Bun tests. Move stint/pit tracking, accumulation/context/rebuild/history events, strategy/baseline/race-plan queries, race-plan routes and session strategy route segments, automatic backfill policy. Sector timing and tracker math used by unrelated timing stay platform/foundation code. Shared DB/schema/migrations/write coordinator, source decoding and lap detection stay backend-core. No app-root imports from feature.

UI implementer owns UI, host UI contract/adapter and browser tests. Coordinator owns manifest/exports/config/root dependency integration, root provider, test discovery/impact, plans/checkpoint/evidence and gates. No build/test/lint/formatter, delegation, staging or commits in implementation workers.

## Tasks

1. Replace real core-to-feature edges in live pipeline, recording reprocess and session-history publication with the contract's neutral `RaceStrategyRuntime` port. Register real implementations from main/worker app composition before lazy pipeline construction. Backend-core must not import the feature; feature server uses explicit backend-core platform exports. Preserve callbacks, storage ordering, throwing unregistered access and the shared browser-helper ownership defined by the contract (RS-01/05).
2. Move complete feature domain/persistence/routes and owned tests; remove obsolete paths/exports and migrate actual callers. Keep Hono inferred request/response typing and existing middleware/route precedence. Public feature server exports only intentional operations/factories (RS-01/02/05).
3. Finalize automatic backfill: select missing aggregate generations or outdated summaries, use each session's own recording, skip active captures, reconstruct compact metrics, and associate temporary detector windows with existing lap IDs. Commit only strategy state; never update or replace stored lap rows. Preserve missing/corrupt/identity/window mismatch state, continue later independent candidates, persist successful unavailable/empty generations, and honor the contract's stop-between-session/drain-current shutdown behavior (RS-04).

   Extend RS-04/B1 according to the [shared contract](race-strategy-contract.md#existing-protocol-and-state-contracts): retry summaries whose persisted algorithm version is outdated without recreating intentionally empty completed generations. LMU scoring-derived distance is not a monotonic odometer; retain time, identity and lap-window continuity checks. Validate with RS-E08 and existing unsafe-source/idempotence scenarios. G1/G2/L1 reuse unchanged stint and plan endpoints; backend changes do not gate independent UI implementation.
4. Move owned unit/integration specs and suite manifests. Feature integration fixtures initialize real adapters/ports through public exports. Register the actual feature for shared recording/game suites through the contract's application-owned preload; keep pure-unit runs preload-free. Platform lifecycle tests remain platform-owned, including read/flush/maintenance behavior before default-pipeline construction. Do not import app-private initialization from feature implementations or create a package cycle (RS-05/06).

## Acceptance and edge handling

Server acceptance is RS-01/02/04/05/06/08. Existing algorithm/units, boundary coalescing, independent wheel availability, source identity/PI/driver compatibility, clear generations/history pagination and race-plan validation preserve shared schemas. Active capture recheck occurs under maintenance lock. Missing source never borrows latest unrelated recording. Identity or lap-window mismatch refuses publication, leaving laps and existing evidence unchanged. Publication remains maintenance lock → write permit → transaction, notifications after commit/permit release. Scan is bounded/paged; existing summaries/completed generation prevent duplicate computation. Work admitted before shutdown settles before locks/DB close.

## Verification

Coordinator executes shared RS-E01/03/04/05/06 after integration. LMU import/native FM compiled-app E2Es cover automatic reconstruction, exact metadata/windows/generation preservation, active/missing/corrupt/identity/window mismatch isolation, later successful candidates, unavailable measurements and repeat startup. Reuse the actual backend boot W-E5 shutdown/queued-admission scenarios for the shared resource owner; compiled fixture shutdown rejects forced kills. Run owned Bun suites, scoped types/lint, real HTTP/WebSocket invalidation, boundary rejection and the shared selection-policy regression. Outcomes and evidence live in the shared contract. Mock-only/in-process-only checks cannot replace real startup E2Es; unexecuted or failed gates remain unverified.
