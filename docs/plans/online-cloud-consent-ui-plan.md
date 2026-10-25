# Desktop Online consent handoff plan

Contract: [shared Online cloud consent handoff](online-cloud-consent-contract.md)
Cloud implementation: [website consent flow plan](../../../../../projects/raceiq%20cloud/docs/plans/online-cloud-consent-backend-plan.md)

## Scope and ownership

Desktop UI owner: `packages/online/ui/settings/OnlineSection.tsx`, client navigation state for Settings/onboarding, Online E2E, and desktop changelog.

Keep consent-required gating, Online service contracts and Cloud API unchanged. SPA navigates current tab to fixed `https://raceiq.snazzie.space/flows/consent` with absolute current loopback URL. Cloud returns same tab after confirmed acceptance; no popup or native deep link.

## Tasks

1. Keep Settings section and onboarding step URL-backed using shared contract shapes; invalid values use existing safe defaults.
2. Replace relative `desktopReturnTo` with absolute `browserReturnTo` from current `window.location.href`; strip auth query secrets and preserve route, search, and fragment.
3. Navigate current tab to the fixed website consent URL. Remove consent-specific `raceiq://` callback parsing, forwarding, and obsolete tests; retain protocol activation for import links.
4. Verify returning to SPA reloads URL-backed Settings/onboarding state and fetches authoritative consent for local account; callback never proves acceptance.
5. Test query encoding, same-tab navigation, exact browser return URL, route-state restoration, and consent refresh; update changelog.
6. Resolve release-audit secret leaks and the consent lint failure without weakening validation. Extend browser regressions for adjacent, mixed-case, and benign-first fragment auth parameters (CC-11, E2E-CC-10).
7. Add safe invalid Settings/onboarding state and legacy consent activation rejection coverage. Final integration must use actual SPA, website and API rather than fixture acceptance plus manual return (CC-07/08/09).
8. Correct worker SQL fixture type narrowing and write-authority setup that block project typecheck/unit gates. Include the shared lease fix that materializes lazy Drizzle operations before Effect resource finalization; preserve cross-worker lease, rollback, and competing-writer assertions.
9. User-approved release-gate expansion: replace the restricted SQLite driver in `server/db/online-upload-legacy-conversion.ts` with the repository-supported libsql pattern while preserving read-only legacy storage, all receipt/identity semantics, and error propagation. Remove only needless SQL quote escapes. Verify existing migration fixtures against actual SQLite, including intact source data and repeat conversion.
10. Replace the control-character regex in `server/runtime/desktop.ts` without weakening same-origin dashboard launch validation. Exercise invalid origins, credentials, control characters, backslashes and safe same-origin routes without launching a native application.

## Acceptance and edge mapping

- CC-01: CTA navigates same tab to `/flows/consent?browserReturnTo=...` with full current URL; no local consent mutation; E2E-CC-1/8.
- CC-07: returned SPA reloads and local API state controls gate; website identity mismatch stays blocked; E2E-CC-7.
- CC-08/09: Settings section and onboarding step survive OAuth and same-tab redirect; E2E-CC-8.
- CC-06/10: SPA strips secrets; Cloud validates loopback origin/referrer and rejects malformed or external targets; E2E-CC-9.
- Cloud OAuth, API failure, stale policy: SPA does not preempt Cloud recovery.

## Verification

Desktop release-audit verification:

- Passed `bun run build:browser` after the connected-account onboarding correction.
- Passed focused compiled Playwright Online consent E2E with retries disabled: 6 tests. Coverage includes same-tab website launch, mixed-case/adjacent/query-shaped-fragment secret stripping, authoritative remote acceptance refresh, Settings/onboarding route restoration, and invalid route-state fallback.
- Passed `bun run typecheck` and `bun run lint`: 37 package tasks each. Passed `bun run test:shards`: all 443 ordinary tests assigned exactly once.
- Passed `bun run test:unit --concurrency=1`: 13 package tasks, including 380 backend tests and 1,273 backend assertions. Serial execution avoids resource-contention failures observed during a concurrent browser build; no assertions or timeouts were weakened.
- Passed worker SQL regression: 5 tests, 31 assertions. Passed protocol activation regression: 2 tests, 19 assertions, including rejection of legacy consent activation and preservation of import links.
- Passed legacy-conversion integration: 2 tests exercising actual initialization and conversion, unchanged source bytes, no creation of absent legacy storage, and repeat safety.
- Passed an isolated additive migration smoke using committed migration history plus migration 104: 84 migrations applied, conversion schema present, and zero foreign-key violations. Historical migration rewrites remain excluded from the intended commit.
- Exercised dashboard launch validation with a mocked process launcher: external/scheme-relative destinations, backslashes, and control characters were rejected; a safe same-origin onboarding route was preserved. No native application was opened.
- Passed `bun run e2e:cloud-consent-spa` in Cloud with the actual compiled localhost SPA/backend, Bun website, and Rust API: same-tab Settings return, onboarding-step return, and different-account isolation. Passed final Cloud failure-path suite; see [Cloud verification](../../../../../projects/raceiq%20cloud/docs/plans/online-cloud-consent-backend-plan.md#verification).
- Production policy activation remains blocked on operator/legal approval and matching published website/API versions, as documented in the shared contract.
