# Valid non-pace laps: UI implementation plan

Status: automatic-upgrade presentation, real HTTP/WebSocket retry/reconnect, keyboard controls, dock priority, and narrow/wide verification pass. See [executed evidence and remaining full-feature acceptance](valid-non-pace-laps-contract.md#executed-automatic-upgrade-evidence); the broader UI acceptance matrix remains open.

Requirements: [feature plan](valid-non-pace-laps.md). Boundary and acceptance authority: [shared contract](valid-non-pace-laps-contract.md). Architecture: [ADR](../adr/0011-valid-non-pace-laps.md). Backend counterpart: [backend plan](valid-non-pace-laps-backend-plan.md).

The classification timeline presentation gap is scoped separately in the [timeline UI plan](session-classification-timeline-ui-plan.md) and its [shared boundary and TL acceptance matrix](session-classification-timeline-contract.md). That extension remains planning-only and is not included in the earlier maintenance-flow verification.

## Scope and ownership

UI owner implements feature-owned status store, existing global WebSocket subscription/HTTP restoration, automatic-migration dock and inline maintenance details, translated classification presentation, default pace selection, and explicit inspection/comparison behavior. Own affected `client/src/stores/telemetry.ts`, `client/src/hooks/useWebSocket.ts`, `client/src/routes/__root.tsx`, `client/src/components/ProcessingMaintenance.tsx`, feature-owned migration presenter, `RecordedLaps.tsx`, `LapTimeChart.tsx`, selectors/hooks, and supported locale messages. Preserve incumbent design; no unrelated redesign or generic background-task framework.

Backend owner supplies shared types and production operations. UI implementation proceeds in parallel using contract-conforming development fixtures; fixtures must not remain production fallbacks. UI owner does not edit shared DTOs or server state semantics unilaterally. Integration owner executes shared real-system E2E after both layers are available.

## Tasks

1. Consume shared metadata and status DTOs. Keep migration state separate from sparse conversion and existing stale-reprocessing state. Restore authoritative status/unresolved pages on connect/reconnect/Refresh; ignore older revisions, restart stale pagination, preserve last known state on connection errors, and invalidate affected lap/session/dashboard queries on postcommit events and reconnect. Reference AC-03/09.
2. Compose existing background-operation primitives into a feature-owned non-modal dock and persistent `ProcessingMaintenance` section. Upgrade begins automatically: no consent/start action. Apply contract dock precedence; suppression/dismissal never stops work or clears unresolved state. Display factual separate counters, historical-pace warning, specific limitations, and per-recording Retry. Duplicate retry is disabled locally while submission is pending and safe server-side. Reference AC-05/07/09.
3. Add Paraglide copy in every supported locale, accessible progress/status/error semantics and keyboard controls, narrow viewport sizing, wrapping, and terminal dismissal. Resolve source session names through existing metadata; never expose raw file paths. Reference AC-09.
4. Apply shared eligibility to best highlights, sector highlights, defaults/reference selection, chart pace presentation, and session summary consumers. Keep all-lap inventory, classification badges, invalid badges, and manual/experiment exclusions distinct. Explicit non-pace IDs remain inspectable/comparable with warning; no-eligible-lap states never choose non-pace fallback. Reference AC-01/03/04.
5. Extend seeded Playwright scenarios using the real upgrade-server attachment defined by the contract. Development fixtures may cover rendering during parallel work but are not final evidence. Coordinate actual import/export/reprocess and postcommit cache checks with integration owner. Update relevant UI documentation and contribute to the single verified changelog entry owned by backend/integration work, not a duplicate entry.

## Acceptance and edge handling

All shared acceptance definitions and setup/action/assertion scenarios remain in the [shared matrix](valid-non-pace-laps-contract.md#acceptance-criteria-and-e2e-evidence-map).

| UI acceptance | Shared criteria | Required E2E |
| --- | --- | --- |
| UI-01: automatic non-modal progress and visible unresolved records | AC-05/07/09 | E2E-01/04/06 |
| UI-02: restart/reconnect/refresh and retry preserve authoritative state | AC-06/09 | E2E-03/06 |
| UI-03: eligible defaults, retained history, category/validity separation | AC-01/03/04 | E2E-01/07 |
| UI-04: actual narrow/wide translated and accessible presentation | AC-09 | E2E-06/07 |

Zero inventory hides activity (`idle`); limited/failed-only inventory shows attention, not success (E2E-06). Suppressed or dismissed dock leaves inline details usable; existing layout/sparse priority remains intact (E2E-06). Failed request preserves state and permits restoration; reconnect ignores stale revisions and refetches queries rather than depending on missed events (E2E-03/06). Pagination revision mismatch restarts listing, duplicate Retry cannot enqueue duplicate work, unrepaired sources remain visibly limited (E2E-04/06). Legacy-null may remain pace-compatible while pending/limited but never implies successful migration; non-pace-only defaults show empty states; explicitly selected classified laps still work (E2E-07). Long translated copy fits 390px and 1440px widths, status is conveyed without color alone, and background work does not trap focus (E2E-06/07).

## Verification and completion dependency

Run shared E2E-03/06/07 in the actual app attached to the same real upgraded backend/DB, plus relevant observations from E2E-01/04. Execute the targeted seeded Playwright command and Playwright typecheck in the contract; capture narrow/wide visual evidence and keyboard/status assertions. Verify genuine HTTP/WebSocket restoration and production retry/pace queries, not route-response mocks. Backend owner/integration owner supplies parser/crash/concurrency evidence from E2E-01–05; UI completion explicitly depends on passing real cross-layer E2E-03/06/07. Record outcomes by UI/shared acceptance ID and report unavailable fixtures, browser, or backend as blockers. Code implementation alone does not close the acceptance matrix.

## PR correction implementation

Acceptance, edge cases, and concrete integration scenarios: [F08–F10 in the shared contract](valid-non-pace-laps-contract.md#pr-review-corrections). UI owner edits `LapStatsPanel` to retain filter controls around empty filtered pace sets, `useWebSocket` to refresh track-lap caches on commit/reconnect, and app-shell/sparse-dock composition to enforce actual visibility precedence. Preserve styling, translations, inline maintenance access, suppression semantics, and unrelated operation state.

Implement in parallel with the [backend corrections](valid-non-pace-laps-backend-plan.md#pr-correction-implementation), using the unchanged contract. Extend existing browser coverage; integration owner runs real app/backend F08–F10 scenarios at narrow/wide sizes after integration and records requests, visible results, console errors, and verification gaps. Root typecheck and focused component checks supplement browser evidence.

Correction execution results and narrow/wide captures are linked from [the shared evidence record](../../.omp/evidence/pr469-review-fixes/results.json). The real browser scenario exercises sparse consent/completion/dismissal, empty Race/Quali recovery, post-commit track-cache refresh, offline recovery, backend reconnect, and layout precedence.
