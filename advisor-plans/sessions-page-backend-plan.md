# Sessions page backend extraction plan

Authority: [shared contract](sessions-page-contract.md); counterpart: [UI plan](sessions-page-ui-plan.md).

## Scope and tasks

1. Move `apps/backend/src/routes/session-routes.ts` into `packages/sessions-page/server/`. Export a typed route factory from `/server` receiving the existing app-owned catalog identity validator. Preserve every handler, validator, error and notification; no capture/DB engine redesign.
2. Keep application registration thin: instantiate factory with `isSessionIdentityInCatalog`. Migrate all route consumers/tests to public package entry or the genuine app registration as appropriate, without compatibility shims.
3. Move exclusively owned session route tests into package integration ownership when their fixture dependencies permit; retain genuinely cross-feature tests with their current owners and migrate imports. Coordinator owns manifests, test manifests, typecheck configuration and E2E registration.

## Acceptance, edges and verification

Own SES-4; contribute SES-2/5 in the [shared matrix](sessions-page-contract.md#acceptance-and-e2e-strategy). Missing/wrong-game IDs, invalid catalog identities, null notes, unavailable results, missing raw source, cursor errors, active capture and partial delete retain current handling by preserving existing routes and regression assertions.

Backend work proceeds independently of UI against unchanged HTTP contracts. Coordinator runs actual session route regressions, scoped backend/package typechecks and compiled-app HTTP requests plus relocated feature E2Es with real API/DB. Browser build and transitive boundary rejection prove no server/native module leaks into UI. Test discovery/selection checks share the coordinator owner defined in contract. Completion requires recorded passing integrated outcomes; unavailable scenarios are blockers, not inferred success.

## Implementation outcome

The complete session route chain now lives in `packages/sessions-page/server/`; application registration injects the existing typed catalog validator. All former route consumers use the public factory. The exclusively owned identity-repair route regression moved into the package integration suite; genuine cross-feature tests stayed with their existing owners.

Package route integration and 42 migrated backend consumer regressions passed, alongside backend/public typing, real compiled HTTP validation/error checks and the final complete Sessions browser suite. Exact evidence and unexercised original error branches are recorded in the [contract verification section](sessions-page-contract.md#implementation-and-recorded-verification). The broader full-mode run still has failures outside this route extraction; full-repository acceptance is not claimed.
