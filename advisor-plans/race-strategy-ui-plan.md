# Race strategy UI extraction plan

Contract: [race-strategy-contract.md](race-strategy-contract.md). Server plan: [race-strategy-backend-plan.md](race-strategy-backend-plan.md). Follow [feature packages](../docs/architecture/feature-packages.md).

Execution: shared UI integration scenarios passed. See the contract's [execution results and explicit limitations](race-strategy-contract.md#execution-results) for final compiled-app, browser-boundary, story-consumer and static-check evidence; broader recording failures are not counted as passes.

## Scope and ownership

Own `packages/race-strategy/ui/`, typed UI host bindings in `contracts/ui-host.ts` and `contracts/messages.ts`, `client/src/features/race-strategy-host.tsx`, migrated feature UI consumers, and feature browser tests. Move RaceStrategyPlanner, LiveRaceStrategy/CompactRaceStrategy, StrategyHistory, StrategyStints, PitEstimate/PitEstimateDialog, PitWindow, feature query hooks, formatting/projection helpers and focused tests. Preserve app track-focus issue-hover changes without unrelated extraction. Shared DTOs/schemas and the cross-feature live-telemetry view retain the authoritative owners defined in the contract.

The application-owned `client/src/stories/LiveDashboardStoryFrame.tsx` is also a real host-composition consumer. Install the existing provider around its router and render the supplied story through a route function; retain typed class/function story support without changing production feature behavior.

Coordinator owns package manifest/config/lockfile, root provider, shared contracts export index and test discovery/config. Server implementer owns backend code and Bun tests. No overlapping editors. No build/test/lint/formatter, delegation, staging or commits in implementation workers; coordinator verifies.

## Tasks

1. Inspect current imports and existing catalogue host-provider pattern; use typed host bindings for shared controls, translations, authenticated RPC, settings/session/telemetry and routing. Feature owns query hooks; no reverse client imports, duplicated clients, unsafe casts or fake production data.
2. Move complete feature UI and focused tests, migrate callers to public `@raceiq/race-strategy/ui` entries, and remove obsolete files/aliases. Move the shared live-view helper and focused test to the contract's existing foundation package and migrate every consumer. Preserve standalone planning, current-session Stint averages and visible persistence-failure reporting in compact/expanded views (RS-01/02/03/05).
3. Move exclusively owned browser specs/support into feature `test/e2e/`; adjust relative shared harness/fixtures, preserve test identities. Change isolated runtime to actual compiled app, retaining controlled native input, restarts/fault injection and real persistence. Resolve existing LMU fixture conversion under Bun rather than calling Bun-only recorder from Node Playwright runtime (RS-06).
4. Report exact changed paths, required host/root composition changes and unresolved integration edges. Contract-conforming fixtures allowed during UI work, never substitute production integration.

## Acceptance and edge handling

UI acceptance is RS-01/02/03/05/06/08 from shared contract. Session empty/single/multiple stints, optional comparison transitions, units/nullable measurements, compound incompatibility, game/session changes, plan load/save failures and pending mutations retain contract-defined behavior. Existing history pagination/clear/reconnect and live applicability must remain intact. Missing persisted aggregates wait for real backfill/refetch; no client-side invented averages or unrelated recording matching.

For G1/G2/L1, implement the [shared generation and list contract](race-strategy-contract.md#existing-protocol-and-state-contracts) in feature UI and the existing strategy route. Reuse the existing planner for draft review/editing and existing authenticated CRUD for persistence. Own generation arithmetic, explicit capacity/reserve inputs, source/session handoff, selected-game listing and localized empty/error/loading states. Execute shared RS-E07 after integration, including invalid reserve, missing evidence, exact-fit capacity, tire-first limits, zero rates, the 100-stint boundary, duration mode and desktop/mobile verification.

## Verification

Coordinator executes shared RS-E01/02/03/05/06 after server and UI integration. Reuse the 31 relocated strategy E2Es and targeted session-tab scenario; extend LMU/FM automatic backfill coverage and run the complete compiled app with desktop/mobile captures. Exercise expanded history/evidence disclosures through real controls, including stale-response rejection, cross-client deletion/clear and committed evidence during storage failures. Scoped UI typecheck, boundary rejection and the production browser module audit supplement runtime proof. Shared-helper consumer/non-consumer selection, exact central discovery and final full-mode execution remain integration completion dependencies. Outcomes and evidence are recorded in the shared contract rather than duplicated here.

Fresh compiled-app smoke must also preserve auth, WebSocket and no-current-session behavior after the neutral pipeline-registration change. The platform's cold idle lifecycle regression supplements this real UI/backend coverage; it does not replace it.
