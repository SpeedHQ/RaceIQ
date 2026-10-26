# 3 to Improve — UI implementation plan

Status: proposed, planning only. No implementation authorized by this document.

Shared boundary and acceptance criteria: [contract](3-to-improve-contract.md). Decision: [ADR 0016](../adr/0016-3-to-improve.md). Parallel work: [backend plan](3-to-improve-backend-plan.md).

## Scope and ownership

Extend the existing session Analyse Overview with the compact coaching section and on-demand evidence panel. Preserve the current design, routes, lap comparison, sector/Analyse views, replay, and shared experiment/single-lap dashboard consumers. Do not build a separate coaching page or redesign session listings.

UI owner: feature UI components and queries, localized copy, presentation fixtures, consumer-visible UI regression cases. Integration owner: shared DTO/schema exports, host/RPC wiring, compiled-app fixtures, E2E execution and final evidence. Backend owner implements the real operations independently after contract approval.

Affected scope: `packages/session-analyse/ui/SessionAnalysePage.tsx`, `SessionReviewDashboard.tsx`, existing `queries.ts` and host interface; add a small `ThreeToImprove` component and evidence panel only when existing components cannot own them clearly. Extend `client/src/features/session-analyse-host.tsx` through the integration owner. Add messages to the existing feature message contract and every `client/messages/` supported locale. Keep exports explicit; no browser import of backend implementation.

## UI acceptance criteria

- **TI-U1 → TI-1/2:** The section renders the server's ranked 0–3 items without client re-ranking. Each card includes a location, localized observed-pattern sentence, exactly one practice action, and Show evidence. Scope says whole eligible session; changing comparison selection cannot change cards.
- **TI-U2 → TI-3:** Evidence opens on demand for the returned representative only, shows its recorded marker and surrounding traces, and closes with focus restored and comparison state unchanged.
- **TI-U3 → TI-4/5:** Loading, no-findings, insufficient data, processing, failed processing, transport errors and changed evidence are distinct states. Pending/failed session or game/session navigation cannot display stale cards.
- **TI-U4 → TI-6:** Both session URL forms, mobile layout, keyboard access, units, supported locales and existing consumers retain behavior without extra full-session telemetry downloads.

## Tasks

1. Integration owner publishes contract DTOs and typed host service signatures for summary and detail, plus localized message interface changes. Verify all existing host implementations, fixtures and affected callers; production services use typed Hono RPC and existing aligned-trace decoding. No raw-fetch workaround.
2. UI owner adds a summary query keyed by feature, game and session. Enable only for a resolved session; comparison IDs are deliberately absent from the key. Keep summary loading/error scoped to the coaching section where the page otherwise remains valid. Reuse the page's session-processing shell when the entire session is blocked.
3. Place the section in session Overview only, near its start. Do not enable it automatically for experiment/group/single-lap dashboard consumers. Render the authoritative ranking, scope counts, single-lap/repeated wording, curated corner or percentage fallback and any missing-location limitation. Do not render severity or saved-time claims absent from the contract.
4. Reuse shared controls and charts for the in-place evidence panel. Load detail only after activation. Decode the existing aligned payload; use distance fractions and the returned marker, never raw frame indices as chart positions. Chart unavailable channels as unavailable, preserving existing units. Keep error/refresh UI within the panel; changed evidence refreshes summary and requires user selection again, never silently opens another sample.
5. Hook query invalidation into existing processing-completion, exclusion-change and deletion paths through the integration owner. Hide stale cards while processing/failed. Close obsolete evidence when game/session or representative changes. Preserve existing URL fields and selection; no new URL contract is needed.
6. Extend existing UI fixtures and targeted behavioral tests for uncertain state transitions and focus restoration. After production integration, update relevant user documentation and the customer-facing changelog once, coordinated with backend work; do not claim a feature shipped in planning-only changes.

## Edge handling and E2E mapping

Definitions and setup/action/outcome details live only in the [shared E2E table](3-to-improve-contract.md#edge-cases-and-shared-e2e-strategy).

| UI case | Planned handling | Required E2E / criteria |
| --- | --- | --- |
| Three, fewer, or no actions | Render exact server list; honest empty state, no padding. | TI-E1/E2; TI-U1/U3 |
| One supporting lap | Single-lap label, never repeated-pattern wording. | TI-E2; TI-U1 |
| Missing location or channel | Show contract limitation; never fake a corner, trace or target. | TI-E3/E5; TI-U1/U3 |
| Pending → ready or failed | Reuse processing status and refetch; no stale coaching during blocked states. | TI-E6/E9; TI-U3 |
| Wrong/deleted/stale evidence | Show real error or refresh affordance; do not substitute lap/sample. | TI-E4/E7/E9; TI-U2/U3 |
| Comparison change | Whole-session coaching remains independent; closing evidence preserves selection. | TI-E1/E4; TI-U1/U2 |
| Mobile, keyboard, translations, units | Shared controls, named regions, focus restoration, readable traces and responsive stacking. | TI-E8; TI-U2/U4 |
| Shared dashboard consumers | Session-only opt-in, unchanged existing navigation/views. | TI-E8; TI-U4 |

## Verification and completion dependency

UI development can use typed contract-conforming fixtures before backend completion, without a production fallback. Integration owner then runs the real compiled-app TI-E1–E9 scenarios and existing affected group-review/replay/shared-consumer coverage, with real endpoint requests and recordings. Record desktop/mobile screenshots, keyboard outcomes, browser errors, request scope and exact command results in the implementation verification report. Component tests alone are not completion evidence.

Required gates after integration: existing feature typecheck/lint/boundary gates, root `bun run typecheck`, targeted behavioral regressions and feature E2E command from the current package manifest. Reuse existing package scripts rather than introduce new commands for this feature. All TI-U criteria and mapped shared criteria must pass; unavailable fixtures or environments remain explicit blockers, not skipped proof.

Planning outcome: documents only. Application, browser and tests have not been run for this proposal.
