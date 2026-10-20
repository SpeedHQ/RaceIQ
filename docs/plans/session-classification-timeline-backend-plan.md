# Session classification timeline: backend implementation plan

Status: planned only; not implemented or tested.

Boundary: [shared contract, TL acceptance and E2E scenarios](session-classification-timeline-contract.md). Counterpart: [UI plan](session-classification-timeline-ui-plan.md). Decision: [ADR 0011](../adr/0011-valid-non-pace-laps.md). Related scope: [classification backend plan](valid-non-pace-laps-backend-plan.md).

## Scope and non-goals

Expose existing stored capture ordering in public lap metadata so the Sessions timeline can display source order without inventing it from lap number or insert time. Classification and validity already exist in `LapMeta`; this change consumes them rather than modifying their detector or migration.

No schema migration, timeline persistence, new endpoint, raw capture decoding, native-event synthesis, result reconciliation change, or data mutation on timeline reads. Existing authentication/game/ownership scoping and read-operation errors remain unchanged. Never expose raw source paths.

## Ownership and parallel boundary

Backend owner edits `shared/racing/sessions/types.ts`, `server/db/lap-meta.ts`, and only existing query projections needed to expose the field consistently. Relevant selectors live in `server/db/lap-read-queries.ts` and other actual callers of `toLapMeta`; resolve references with the language server before implementation. Backend owner is sole editor of shared metadata and contract amendments.

Integration owner owns fixture/transport extensions to the existing `apps/backend/test/e2e/support/` and `client/test/support/upgrade-browser-server.ts` harnesses, the targeted Playwright scenarios and evidence collection. UI work proceeds independently after boundary approval, using contract-shaped development fixtures until the real metadata extension is available. Final integration validation is a real dependency; backend completion must not be declared from a serializer test alone.

## Implementation tasks

1. Add the contract's optional nullable `rawByteOffset` field to `LapMeta`, documenting byte-position semantics and absence handling. Existing fields/classification vocabulary are unchanged. Trace actual `toLapMeta` callers and any alternate public lap serializers before edits; update consumers only where required by the additive field. References TL-04/08; TL-E01/03/05.
2. Preserve `StoredLapMetaRow.rawByteOffset` in the normalized public representation, returning a safe nonnegative integer or null without changing the row. Current inventory, session-scoped and explicit-ID responses expose the field consistently; select the stored value where needed rather than deriving one. Keep `rawFile` private and existing `telemetryAvailable` behavior unchanged. References TL-02/04/08; TL-E01/03/05.
3. Verify existing metadata reads still retain invalid, non-pace, unclassified, manually excluded and telemetry-removed laps and their IDs. Do not filter, reorder SQL for this presentation, add additional per-row reads, or alter best-lap/pace-query semantics. Timeline presentation ordering belongs to the contract/UI. References TL-01/02/08; TL-E01/05.
4. Supply isolated capture-backed metadata/event fixtures for the shared E2E scenarios, including source-order/ID disagreement, repeated lap numbers, nullable/unsafe offsets, validity/category independence and inaccessible metadata. Preserve real HTTP/DB serialization and existing authorization. Extend only owned test transport controls for loading/failure scenarios; do not introduce production debug routes or fulfill real successful operations with mocks. References TL-01–08; TL-E01–08.
5. Integrate with actual automatic-classification and native-result paths for TL-E07. Reuse existing notifications: classification commits invalidate lap metadata and native reconciliation invalidates native results. No new event envelope or mutation endpoint. Verify the UI reconnect refresh covers both read families. References TL-03/06; TL-E02/07.

## Acceptance and edge handling

Adopt the authoritative [TL-01–08 acceptance and edge/E2E map](session-classification-timeline-contract.md#observable-acceptance). Backend obligations are TL-08 in full, metadata/order support for TL-01/02/04, and real operation support for TL-03/05/06/07. The same shared E2E execution owner closes cross-layer evidence for both plans.

- Zero offset is valid; missing, negative, noninteger, nonfinite or unsafe offsets normalize to null in API output. Never repair stored indexes as a side effect of reads. TL-04/08; TL-E03.
- Equal offsets remain equal metadata, not merged laps; UI displays uncertain order. Repeated lap numbers preserve separate IDs. TL-01/04; TL-E01/03.
- Missing source/removed telemetry leaves metadata readable but inspection unavailable; category and validity do not change. TL-02/08; TL-E05.
- Other games/ownership and unauthorized clients retain existing API behavior. No new authorization shortcut or path field is added. TL-08; TL-E05.
- Partial/failed metadata requests retain normal error responses; no successful empty response replaces an error. TL-05; TL-E06.

## Required verification after implementation

Integration owner executes **all TL-E01–08** as defined in the shared contract, through the actual Sessions application and affected reads/mutations/notifications. The real ACC upgrade scenario must prove classification changes reach an already-open timeline; fixture-only category rendering is not that proof. Snapshot affected source/session/lap/event fields and raw hashes to show read-only navigation causes no mutation.

Extend existing metadata/database contract tests at their current ownership seam for safe/null offset behavior and field omission/privacy; use focused behavioral assertions, not complete-object snapshots pinned to incidental shape. Preserve existing native-ledger tests and run relevant query/serialization suites as supplements, not E2E substitutes.

Run the shared targeted seeded Playwright command and `bunx tsc --project tsconfig.json --noEmit` from `playwright/`, then root `bun run typecheck` and `bun run lint`. Record exact fixtures, commands, outcomes and evidence by TL ID after implementation; rerun only invalidated scopes. No verification or implementation for this extension is authorized by this planning-only request.
