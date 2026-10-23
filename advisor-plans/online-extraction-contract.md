# Online feature-package extraction contract

Status: implementation authorized by the request to move Online code into its package and follow the feature-package document. No behavior redesign, commit, deployment or checkpoint is requested.

Pattern: [Feature packages](../docs/architecture/feature-packages.md). Plans: [UI](online-extraction-ui-plan.md), [backend](online-extraction-backend-plan.md).

## Agreed boundary

`@raceiq/online` owns top-level `ui/`, `server/`, `contracts/`, its existing delivery/storage tests, exclusively Online HTTP/controller tests and browser E2Es. Remove `src/` and obsolete implementation paths. Explicit `./ui`, `./server`, `./contracts` exports; narrowly named public server leaves are allowed only for genuine shared consumers, never a mixed root or wildcard. Preserve current working-tree changes.

The application retains thin route registration, host RPC implementation, shared UI controls/translations/navigation bindings, global DB/migration/write coordination, game initialization, keystore/browser operations and process lifecycle. Feature implementations cannot import application source. Shared capture processing and authoritative app-owned DB queries remain platform services. Keep the workspace graph acyclic: inject platform services rather than adding a reverse backend-core dependency while backend-core consumes Online contracts/services. Existing genuinely shared identity/summary definitions may move to the appropriate shared leaf with every caller migrated; do not copy them.

UI host bindings are precise browser-safe types owned by the feature. The app supplies existing Hono RPC-backed operations, shared controls, translations, navigation and context. Preserve provider/query/cache behavior. No raw-fetch replacement, unsafe type-erasure, fake fallback or duplicated global state.

## Protocol authority

All endpoints, DTO field types/nullability, authentication, OAuth/PKCE, origin/CSRF protections, account epochs, expected revisions, pagination, ordering, errors and state transitions remain exactly as defined by current Online contracts, Hono route factories and [release contract](../docs/plans/raceiq-online-contract.md). This extraction relocates authority without changing the protocol. Example: `GET /api/online/state` returns the current `OnlineState`; preference mutations retain `{accountEpoch, expectedRevision, preferences:{visibility:'private'|'public',setupUploads:boolean}}`; stale account/revision remains `stale_state`. Queue cursors stay account/view-bound. Sign-out preserves local capture/history and blocks remote starts. No migration or persistent-file format changes.

## Acceptance

| ID | Observable result |
| --- | --- |
| ON-01 | Online UI, server implementation, local contracts and exclusively owned tests live in one feature workspace; callers use public entries and old implementations are removed. |
| ON-02 | Existing settings/onboarding, binding, queue/history, summary, Community/replay behavior and typed HTTP responses are unchanged, including private/signed-out/unavailable and stale-account failures. |
| ON-03 | UI/contracts remain transitively browser-safe; server has no reverse app dependency; forbidden imports fail the existing boundary gate; workspace graph is acyclic. |
| ON-04 | Worker startup/shutdown, durable queues, credentials, capture publication, original identity and shared DB authority retain their existing ownership and behavior. |
| ON-05 | Test discovery retains all moved cases exactly once. Online UI/server/contracts/spec changes select Online E2Es; independent changes do not gain a false dependency from app build. Shared/unknown impact remains conservative. |
| ON-06 | Root typecheck, affected package regressions, real application integration, production browser build and selected feature E2Es pass; exact unavailable checks are reported. |

## E2E scenarios and edges

Reuse existing Online journey fixtures and full-app Playwright harness. Isolate temporary DBs, ports and external provider fixtures; mocks may control external providers, not replace application handlers, feature services or persistence.

| ID | Setup → action → expected observation | Criteria |
| --- | --- | --- |
| ON-E01 | Existing deterministic Online journey fixture → sign-in/current consent, change preferences/name/binding, read queue/profile/Community and sign out → existing happy/failure pairs pass through real handlers/service/storage. Stale revisions/epochs reject; blank name preserves old value; private sharing denies Community; outage is unavailable rather than fabricated data. | ON-01/02/04/06 |
| ON-E02 | Full real compiled app with isolated data and loopback external API/OAuth fixtures → open signed-out settings/history on desktop/mobile, authenticate through the real backend callback/SDK/worker, render connected account controls and change sharing with HTTP readback, sign out → existing controls, private/signed-out states and navigation work without unexpected page errors. An owned full-app scenario exercises relocated onboarding choice, checked/focus styles and responsive layout; the existing fresh-install suite is an additional regression check. Expected in-flight profile revision conflicts remain 409; the explicit stale-account scenario verifies `stale_state`. External fixtures never replace application routes, service, worker or persistence. | ON-01/02/03/05/06 |
| ON-E03 | Existing isolated queue/worker fixtures → interrupt/restart/reconcile ambiguous acceptance and stop → same identity, durable outcomes and no duplicate owner; app capture/query integrations retain existing tests. | ON-01/04/06 |
| ON-E04 | Actual boundary CLI with temporary forbidden UI→server import → nonzero; restore → clean gate and production client build. Exercise public app entry after relocation. | ON-03/06 |
| ON-E05 | Compare full discovery before/after; controlled UI/server/spec/shared/unrelated changes using existing Turbo selection → unique ownership and genuine consumer selection. Run selected Online E2E task; deliberate failing selected case propagates failure, then remove sentinel. Missing history retains full fallback. | ON-05/06 |

Integration owner executes these scenarios after both implementation slices settle and records outcomes here. Both plans depend on that final integration evidence; isolated checks alone do not establish completion.

The existing browser harness initially did not provide Online test origins and used a production runtime environment incompatible with the deliberately test-only loopback transport. Extend its startup fixture rather than weakening production guards or accepting an unavailable worker as passing integration. Use a disposable trusted TLS certificate and isolated provider state. UI and backend plans both retain final integration dependency on ON-E02.

## Executed evidence

Implementation and scoped integration checks are complete; broader repository gates are not all green. GPT-6 Luna performed the migration; GPT-6.1 Sol's final read-only review reported no remaining actionable extraction findings. No commits, pushes, checkpoints, production transport relaxations or desktop control were performed.

| Scenario / criteria | Observed outcome | Evidence |
| --- | --- | --- |
| ON-E01; ON-01/02/04/06 | 20 real desktop journey checks pass; Online package has 9 unit and 55 integration passes; contribution/duration ledgers have 24 passes. | `.omp/evidence/online-extraction-journeys-final.log`, `online-extraction-package-regressions-final.log`, `online-extraction-profile-regressions.log` |
| ON-E02; ON-01/02/03/05/06 | Actual compiled app: Online 6/6 (five cases plus setup), tracks 7/7 and cars 7/7 pass. Covers real SDK/PKCE callback, policy acceptance, sharing/name readback, sign-out, origin 403, stale-state 409, desktop/mobile history and onboarding checked/focus styles. | `.omp/evidence/online-extraction-affected-feature-e2es.log` |
| ON-E03; ON-01/04/06 | Package integration covers durable acceptance, child-process crash/redelivery, account switch and graceful stop. Existing native capture consumers: 17 passes. | `.omp/evidence/online-extraction-package-regressions-final.log`, `online-extraction-capture-regressions.log` |
| ON-E04; ON-03/06 | Real boundary CLI rejects a temporary forbidden UI→server import; clean boundary succeeds after removal. Production browser/binary build succeeds; actual compiled integration proves the embedded Online worker starts. | `.omp/evidence/online-extraction-boundary-rejection.log`, `online-extraction-boundaries-final.log`, `online-extraction-production-build.log`, `online-extraction-affected-feature-e2es.log` |
| ON-E05; ON-05/06 | 440 ordinary tests assigned exactly once. Browser discovery: 260 original identities retained, five additions, zero lost/duplicate cases. Actual Turbo isolated Git fixture verifies source/spec/shared/unrelated selection, missing-history fallback, shared-provider selection of all three real feature consumers, unchanged selection empty and Online-spec-only selection isolated. Deliberate selected Playwright/package/Turbo failure exits 1; probe removed. | `.omp/evidence/online-extraction-shards-final.log`, `online-extraction-discovery-summary.json`, `online-extraction-impact-summary.json`, `online-extraction-impact-final-summary.json`, `online-extraction-scm-fallback.log`, `online-extraction-selected-failure.log` |
| ON-06 static gate / review | Root `bun run typecheck`: 37 successful tasks. Online lint: zero warnings/errors. Final Sol review: no actionable extraction findings. | `.omp/evidence/online-extraction-typecheck-passed.log`, `online-extraction-lint-final.log`, `online-extraction-sol-review-final.json`, `online-extraction-models.json` |

Page-only visual inspection additionally confirmed signed-out desktop Settings, desktop/mobile history, enabled connected account controls and mobile checked/focus onboarding styles. Captures: `.omp/evidence/online-extraction-{desktop-settings,desktop-history,mobile-history-detail,connected-settings,mobile-onboarding}.png`. The managed browser's self-signed navigation option failed; the manual connected capture used the same isolated external OAuth fixture through an HTTP client callback instead. The passing Playwright scenario independently exercised browser navigation through that callback.

### Existing failures and verification limits

- Root lint exits 1 on pre-existing `bun:sqlite` imports in application-owned `online-upload-lifecycle-smoke.ts`, `online-upload-http-recovery-smoke.ts` and `online-profile-http-merge-smoke.ts`. These dirty/untracked fixtures predate extraction and were preserved. Online, client and backend-core lint pass; do not describe repository lint as passing.
- Additional existing fresh-install suite: 2 pass, 6 fail, 9 not run after serial failure. Failures concern pending-access wizard ordering/headings and recording-migration navigation/gating. `OnboardingModal.tsx` changes only its Online public imports; extraction does not change that step logic. Do not treat the full fresh-install suite as verified. Exact failures: `.omp/evidence/online-extraction-fresh-onboarding-e2e.log`. The owned Online full-app onboarding scenario and manual responsive inspection pass independently.
- Source changes conservatively select catalogue consumers through the existing shared backend graph; Online spec-only changes remain isolated. This is not a promise of perfect feature-only minimization for all application changes.
- Native sign-in popup/OS browser dispatch, Windows installer/release execution, real hosted-provider qualification and the entire 265-case browser matrix were not exercised. External-provider fixtures prove application SDK/worker/HTTP/persistence integration, not hosted-service behavior.

