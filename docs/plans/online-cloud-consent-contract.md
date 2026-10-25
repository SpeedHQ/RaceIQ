# Online cloud consent handoff contract

Status: implementation and isolated cross-repository browser verification passed. Production rollout remains blocked until the operator approves publication and aligns website documents with active API policy versions.

UI plan: [desktop consent handoff](online-cloud-consent-ui-plan.md)
Backend plan: [cloud website consent flow](../../../../../projects/raceiq%20cloud/docs/plans/online-cloud-consent-backend-plan.md)

## Boundary and decisions

- The UI is a browser SPA served on loopback. It navigates the current tab to the Cloud website; no new tab or native app callback. No bearer token, refresh token, OAuth code, or account identifier crosses boundary.
- Canonical website: `https://raceiq.snazzie.space`; consent route `/flows/consent`; no legacy `/account?consent=required` alias. SPA adds one `browserReturnTo=<encoded absolute current URL>` when launching consent. After current acceptance is confirmed, Cloud redirects same tab to that URL. No `raceiq://` callback or app deep link.
- Existing `GET /api/v1/me/consent` and `PUT /api/v1/me/consent` remain authoritative. Existing JSON request/response, bearer auth, exact current version checking, current-acceptance update semantics, and HTTP errors remain unchanged. API implementation: cloud `apps/raceiq/src/consent.rs`; route shape documented in cloud `README.md` lines 254–256.
- Terms/privacy document links stay canonical `/tos` and `/privacy`; do not overload policy document URLs as acceptance routes. SPA uses fixed site acceptance URL, not service-provided `termsUrl`.
- If browser has no Cloud session, `/flows/consent` uses existing Discord OAuth and preserves validated `browserReturnTo` through OAuth. Once authenticated, website reads current consent and policy, shows current terms/privacy links and explicit consent checkbox, and persists via `PUT /api/v1/me/consent`. Only after API success does it redirect back; acceptance remains pending until API success.
- If already accepted current versions, website redirects to validated `browserReturnTo` without duplicate write. If no valid browser return target exists, show current accepted status.
- `browserReturnTo` is one bounded absolute HTTP(S) URL whose host is `localhost`, `127.0.0.1`, or `[::1]`; its origin must match the initiating page's `document.referrer` origin. Strip auth keys `access_token`, `refresh_token`, `token`, `code`, and `state` from query and fragment. Persist only validated target in session storage across OAuth; if referrer is absent/mismatched or target invalid, do not redirect. Cloud never redirects to arbitrary external hosts.
- Desktop SPA routes Settings as `?settings=<SectionId>` and onboarding as `/onboarding?welcome=true&step=<stepId>`; onboarding may also retain router-owned `redirect` query state. Preserve full same-origin URL through consent handoff. Allowed IDs come from `client/src/components/settings/navigation.ts` and `client/src/components/onboarding/OnboardingModal.tsx`; invalid IDs use each view's existing safe default.
- Example: `/flows/consent?browserReturnTo=http%3A%2F%2Flocalhost%3A3117%2F%3Fsettings%3Dgeneral` redirects same tab to `http://localhost:3117/?settings=general`. Wizard example: `http://localhost:3117/onboarding?welcome=true&step=online-permissions`.

- Live policy status observed 2026-10-24: public API and hosted `/tos` report approved `terms-2026-10-12` and `privacy-2026-10-12`. Local cloud website sources contain candidate 2026-10-21 policies marked unpublished and its header version constants match those candidates. Never activate or claim acceptance for those candidate versions in production without operator/legal publication approval. Isolated E2E MAY use the candidate pair with throwaway API config/database solely to exercise integration; this is not legal approval or production evidence.
- Production ingress is defined by Cloud `cloudflared.docker.yml`: `/api`, `/api/*`, `/docs`, and `/healthz` use the Rust API; website paths, including `/flows/consent`, use the Bun website service directly. Consent HTML and browser return remain website-owned; do not add a Rust consent-page route.

## Operations and shapes

1. SPA-to-website navigation: current browser tab navigates to `GET https://raceiq.snazzie.space/flows/consent?browserReturnTo=<percent-encoded absolute loopback URL>`. Optional for direct website entry. No request body, headers, or desktop credentials. Browser handles Cloud authentication.
2. Website policy read: `GET /api/v1/me/consent`, `Authorization: Bearer <website Supabase access token>`. Existing response is `{ policy: { available: boolean, termsVersion: string | null, termsUrl: string | null, privacyVersion: string | null, privacyUrl: string | null }, currentAcceptance: { termsVersion: string, privacyVersion: string, acceptedAt: string } | null, accepted: boolean }`; cloud Rust serializes `current_acceptance` as `currentAcceptance` (`apps/raceiq/src/consent.rs:209-215`).
3. Website acceptance: `PUT /api/v1/me/consent`, same bearer, JSON `{ termsVersion: string, privacyVersion: string }`. Exact current versions only. Success returns `{ termsVersion: string, privacyVersion: string, acceptedAt: string }`; cloud Rust returns `ConsentAcceptance` after commit (`apps/raceiq/src/consent.rs:278-335`). Invalid body returns 400 `INVALID_REQUEST`/`INVALID_CONSENT`; unauthenticated 401; blocked/deleted account 403; stale policy 409 `CONSENT_VERSION_MISMATCH`; unavailable policy 503 `CONSENT_POLICY_UNAVAILABLE`; internal failures 500. `GET` returns 401/403/500/503 as defined in the same source. No new endpoint or schema required.

No pagination, ordering, or API state-transition changes. Consent DB/API remain Cloud-owned. Browser return reloads the SPA, which reads consent from its own authenticated local API state; website identity is never forwarded.

4. Website-to-SPA return: after API confirms current acceptance, Cloud redirects the same tab to validated `browserReturnTo`; there is no app callback. Target is bounded HTTP(S), loopback host only, and must match initiating `document.referrer` origin. Cloud accepts one value, stores only validated URL in same-tab `sessionStorage` across OAuth, strips auth query keys, and refuses redirect if referrer is absent/mismatched or value is malformed. No redirect before acceptance.

## Acceptance criteria

- CC-01: CTA navigates same tab to fixed HTTPS consent route with current absolute loopback URL; no local acceptance mutation; E2E-CC-1/8.
- CC-02: Consent page keeps validated return target through signed-out OAuth; sign-in alone does not accept; E2E-CC-2.
- CC-03: Website acceptance requires fresh explicit action and successful API write for current versions; GET readback reports accepted for same account; redirect occurs only after API success; E2E-CC-2.
- CC-04: Already-current acceptance redirects to validated SPA URL without duplicate PUT; stale versions require current policy and 409 refresh; E2E-CC-3/4.
- CC-05: API failure leaves acceptance unrecorded, stays on consent page, shows retry/error; unavailable or mismatched policy blocks confirmation/redirect; E2E-CC-5.
- CC-06: Cloud never redirects to arbitrary external host; return URL is bounded, loopback-only, referrer-origin-bound, and has auth query keys stripped; E2E-CC-9.
- CC-07: SPA reload after browser return reads current consent from its own account; wrong website identity leaves gate active; E2E-CC-7.
- CC-08: Consent launch preserves current SPA origin/path/query/fragment through OAuth; confirmed acceptance returns same tab to exact safe URL; E2E-CC-8.
- CC-09: Settings section and onboarding wizard step are URL-backed and restore after redirect; unknown section/step falls back safely; E2E-CC-8.
- CC-10: Malformed, external, mismatched, duplicate, or oversized return targets never redirect; no valid target means remain on consent page. A valid loopback target containing forbidden auth keys may redirect only after those keys are stripped from query and fragment; E2E-CC-9/10.
- CC-11: Secret stripping handles adjacent forbidden keys, mixed-case keys, and benign-first query-shaped fragments before any website request or OAuth redirect is constructed.
- CC-12: A new referrer-validated handoff replaces an abandoned cached target; OAuth continuation still rejects altered targets. Storage failure and OAuth cancellation never accept policies or redirect unsafely.
- CC-13: Built website policy versions must match API versions before confirmation or automatic return. A mismatch, including already-accepted API state, shows unavailable status without PUT or redirect.

## Edge cases and handling

| Case | Required behavior | Criteria |
|---|---|---|
| Website session absent | Keep `/flows/consent` and validated browser return through OAuth; require explicit confirmation after sign-in. | CC-02, CC-03 |
| Website identity differs from local SPA identity | Never transfer/equate identities; only website authenticated account gets acceptance. Reloaded SPA stays gated unless its own account reports current consent. | CC-03, CC-07 |
| Consent already current | Redirect same tab to validated SPA URL without PUT; direct website entry shows accepted status. | CC-04 |
| Policy changed between read and submit | Preserve API 409; reload policy and require fresh explicit confirmation. | CC-04 |
| API unavailable/policy missing | Keep acceptance pending, expose retry; do not redirect. | CC-05 |
| Hostile query/return URL | Accept only bounded loopback URL matching initial referrer origin; strip auth query keys; invalid target stays on consent page. | CC-06, CC-10 |
| Settings open | Preserve full absolute URL including `?settings=`; returned SPA restores Settings and section. | CC-08, CC-09 |
| Onboarding wizard open | Preserve full absolute URL including step and router redirect state; returned SPA restores wizard step. | CC-08, CC-09 |
| Direct web consent entry | No `browserReturnTo`; after acceptance remain on consent page and show status. | CC-10 |
| Browser closed before acceptance | No Cloud state change; SPA remains pending when reopened. | CC-03, CC-07 |
| Return referrer absent/mismatched | Reject automatic redirect and keep consent status visible. | CC-06, CC-10 |
| Site/API policy mismatch | Block confirmation and redirect; show unavailable state. Do not accept unapproved candidate versions. | CC-05 |
| Adjacent or benign-first credential parameters | Sanitize a snapshot of all query keys and every query-shaped fragment before browser navigation; retain ordinary state. | CC-06, CC-11 |
| Abandoned handoff followed by a different route | Prefer a freshly referrer-validated target; use exact cached matching only for OAuth continuation. | CC-08, CC-12 |
| Browser storage unavailable or OAuth cancelled | Preserve explicit acceptance requirements, show recoverable status, and never perform an unverified redirect. | CC-02, CC-03, CC-12 |

## Shared E2E strategy and ownership

Use existing desktop Playwright Online suite and cloud real Rust API + website journey harness. The cloud scenario uses isolated SQLite, actual API process and browser/site build; only Supabase identity provider is fixture-controlled. Do not mock the application API or replace the website acceptance component.

- E2E-CC-1: Seed consent-required SPA state; click CTA; observe same-tab navigation to exact consent URL with full safe absolute return URL; assert local consent remains pending.
- E2E-CC-2: Start actual consent page from deterministic loopback SPA fixture with matching referrer; authenticate through OAuth fixture; return to exact route; assert pending; explicitly confirm; read same account through GET and assert accepted versions/timestamp; observe same-tab redirect to original SPA URL only after success.
- E2E-CC-3: Seed already accepted current versions; visit consent route with validated return URL; assert no PUT and same-tab redirect. Direct entry without return target shows accepted state.
- E2E-CC-4: Change policy between read and submit; assert 409 refresh, old acceptance retained, fresh confirmation required.
- E2E-CC-5: Stop actual API; assert visible retry/error and no acceptance/redirect. Disable API policy while site/API differ; assert release-unavailable state, no confirmation/redirect/acceptance; restore and reload.
- E2E-CC-7: After same-tab redirect, actual SPA reload reads exact-current acceptance for its own account; mismatched website account leaves consent gate visible.
- E2E-CC-8: Open consent from Settings and in-progress onboarding; assert full URL including route state is preserved through OAuth and returned SPA renders same view/step.
- E2E-CC-9: Supply malformed, external, non-loopback, referrer-mismatched, duplicate and oversized return URLs; assert no redirect and remain on consent page. For otherwise-valid secret-bearing targets, assert only the sanitized URL is retained and used for OAuth and return.
- E2E-CC-10: Exercise adjacent, mixed-case, and benign-first fragment secrets; observe outgoing website/OAuth URLs and final return, with no secret value surviving.
- E2E-CC-11: Interrupt a handoff, launch from a different SPA route, and finish acceptance; assert return to the new route. Also exercise storage failure, OAuth cancellation/retry, and tampered callback target.
- E2E-CC-12: Configure an available API policy that differs from built website documents, both unaccepted and already accepted; assert no confirmation, PUT, or redirect. Change actual API versions between GET and PUT and verify 409 recovery.
- Final integration owner must exercise the actual localhost SPA and Cloud website/API in one browser journey, using production-equivalent split ingress and controlled external identity only. Validate Settings, onboarding, exact safe return, and a different Cloud account. Record unavailable production authentication or publication prerequisites separately.

E2E-CC-7 validates reload and local account refresh; Cloud harness exercises actual site/API with deterministic loopback destination and referrer. Do not replace Cloud API persistence or consent UI with mocks.

Desktop owner runs E2E-CC-1 and E2E-CC-7/8; Cloud owner runs E2E-CC-2 through E2E-CC-6 and E2E-CC-9. Both plans link this shared scenario definition; Cloud acceptance and local SPA reload are exercised end-to-end.

## Executed integration evidence

- `bun run e2e:cloud-consent-spa` in the Cloud repository, with `RACEIQ_DESKTOP_REPO` and `RACEIQ_E2E_BROWSER_BINARY` set to the real desktop repository and its compiled browser server: passed Settings return, onboarding step return, and website/local-account isolation. The browser used the canonical HTTPS website origin through an owned local proxy; the real localhost SPA/backend, Bun static website, and Rust API ran with isolated data. Only the external identity provider was controlled. This covers CC-01, CC-03, and CC-07 through CC-09 across the actual integration.
- `bun run e2e:cloud-consent`: passed OAuth preservation, explicit acceptance, already-current return without duplicate PUT, real API policy-change 409 recovery, API/policy failures, hostile and referrer-mismatched targets, secret stripping, abandoned-target replacement, storage failures, OAuth cancellation/retry, tampered callbacks, and built-policy mismatch for accepted and unaccepted accounts. This covers CC-02 through CC-06 and CC-08 through CC-13.
- Focused compiled Desktop Playwright run with retries disabled: 6 tests passed, covering launch, authoritative acceptance refresh, secret ordering/casing/fragment handling, URL-backed state restoration, and invalid Settings/onboarding fallback.
- Full gate outcomes and the policy-publication limitation are recorded in the linked implementation plans. No production deployment, live Discord sign-in, or legal-policy publication was performed.
