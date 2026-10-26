# RaceIQ Cloud website consent acceptance plan

Contract: [shared Online cloud consent handoff](../../../../workspaces/RaceIQ/online/docs/plans/online-cloud-consent-contract.md)
Desktop implementation: [desktop consent handoff plan](../../../../workspaces/RaceIQ/online/docs/plans/online-cloud-consent-ui-plan.md)

## Scope and ownership

Cloud owner: `apps/account-website/src/ui/SiteHeader.tsx`, `apps/account-website/src/pages/flows/consent.astro`, website browser E2E/smoke harness, cloud `changelog.md` and README.

Existing Rust `GET/PUT /api/v1/me/consent` already provides authenticated current-policy read and exact-version acceptance persistence. Keep endpoint, DB schema, request/response shapes, auth, errors, first-acceptance preservation and policy-version semantics unchanged unless implementation evidence proves a contract defect; any boundary change must update shared contract and both plans before code.

## Tasks

1. Make `/account?consent=required` a stable entry for acceptance. Preserve this fixed same-origin route/query through Discord OAuth sign-in; the existing `AccountApp.signIn()` currently defaults to `/account` and drops this query. Ignore arbitrary `returnTo` values for this intent; keep existing safe leaderboard returns unchanged.
2. After auth restoration, show existing policy panel and require its explicit checkbox + Confirm policies action. API success alone marks accepted; sign-in or landing on page never does.
3. Correct page behavior for already-current acceptance, unavailable policy/API, stale policy 409, retry and account switch per shared contract. Keep `/tos` and `/privacy` as documents.
4. Extend deterministic website browser E2E with actual page/UI and actual local Rust API + isolated DB; only external identity provider may be fixture-controlled. Assert GET persistence readback.
5. Update cloud customer changelog/docs once; do not claim candidate legal policy publication/approval.

## Acceptance and edge mapping

- CC-02/03: signed-out OAuth return preserves exact destination; sign-in does not consent; explicit confirmation writes current policy; E2E-CC-2.
- CC-04: preaccepted current policy shows accepted without PUT; 409 stale policy reloads current docs and requires fresh action; E2E-CC-3/4.
- CC-05: API outage/policy unavailable keeps consent unaccepted with retry/error; E2E-CC-5.
- CC-06: hostile `returnTo`/query cannot navigate off-site; no tokens in URL; E2E-CC-6.
- CC-03: acceptance is scoped to verified website bearer identity; switching accounts reloads state without inheriting prior acceptance; E2E-CC-2.
- Desktop API/consent integration unchanged; E2E-CC-7 remains blocked pending an accessible Cloud website/API checkout and runnable cross-application harness to verify the same actual account through desktop refresh.

## Verification

Reuse cloud account website build and existing actual API smoke harness. Extend website browser coverage without substituting mock API echoes for API persistence. Run E2E-CC-2 through E2E-CC-6; record commands, actual outcomes, and gaps. Integrator executes E2E-CC-1/2/7 across app + website with isolated browser profiles and controlled OAuth fixture. No hosted login/deployment claims without authorized live environment. For E2E-CC-7, first provide accessible Cloud website/API checkout and actual runnable integration harness; then use one isolated API-backed account across website acceptance, callback activation, and desktop's real consent refresh. Current controlled desktop fixtures and independent Cloud tests do not satisfy this criterion.
