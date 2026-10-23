# iRacing OAuth and iRating Tracker Contract

**Status:** agreed implementation boundary. Per-install client credentials; credentials remain in the RaceIQ backend OS keystore. OAuth client registration is paused by iRacing; existing registered clients can be configured.

## API boundary

All paths under `/api/iracing-rating`; same-origin app authentication and CSRF rules apply. Backend owns redirect URL and OAuth state. Client credentials enter through the settings form and request body, but the browser never reads them back; tokens and upstream errors never reach the browser.

- `GET /status` → `{ configured: boolean, connected: boolean, customerId: number|null, displayName: string|null, lastSyncedAt: string|null }`.
- `PUT /client` body `{ clientId: string, clientSecret: string, redirectUri: string }`; nonempty strings, redirect URI must be local RaceIQ callback URL; response `{ configured: true }`. Store secret only in OS keystore. `DELETE /client` clears client configuration and tokens.
- `GET /authorize` → `302` to iRacing authorization service. Backend generates unpredictable state and retains it server-side with one-use/expiry semantics.
- `GET /callback?code=...&state=...` validates and consumes state, exchanges authorization code server-side, verifies identity, persists token server-side, then redirects to `/iracing/rating?rating=connected|error` without query secrets.
- `GET /history` → `{ customerId: number, entries: Array<{ categoryId: number, categoryName: string, observedAt: string, irating: number, change: number|null }> , lastSyncedAt: string|null }`; ascending order by observation time, category ID tie-break. Empty history is `entries: []`; disconnected is HTTP 409 `{ error: "not_connected" }`.
- `POST /sync` → `{ imported: number, lastSyncedAt: string }`; protected API failures return stable `{ error: "upstream_unavailable"|"reauthorization_required" }`, without upstream body/token details.
- `DELETE /connection` revokes local connection state and deletes access/refresh tokens and pending OAuth state; response `{ connected: false }`.

OAuth uses authorization-code + PKCE, `state`, and `iracing.auth` scope, according to current `@iracing-data/oauth-client` and official iRacing OAuth contracts. `/token` requests must send the client secret masked as Base64(SHA-256(secret + trimmed, lower-case client ID)); the unmodified secret remains in the OS keystore. Callback URI must exactly match client registration. Rating source: authenticated iRacing API member recent race/results records; import only completed events with valid category, timestamp and numeric iRating. The source exposes at most its latest 10 official races, so users must sync regularly. Duplicate event observations are idempotent. If official response lacks enough data to represent an iRating change, do not infer a fabricated value.

## Acceptance criteria

- IR-1: Valid state succeeds once; missing, expired, replayed, or mismatched state is rejected and stores no token.
- IR-2: Client secret and tokens never appear in settings/status/history responses, browser storage, URL after callback, or application logs.
- IR-3: Token refresh happens server-side before protected calls; refresh failure produces reauthorization-required without deleting history.
- IR-4: Settings configuration uses keystore; changing client removes the prior connection, disconnect removes tokens but preserves history, deleting client removes configuration and tokens.
- IR-5: Sync imports valid category-specific iRating records once; malformed, duplicate, out-of-order, and empty upstream data preserve ordering and idempotence.
- IR-6: Tracker displays per-category progression, gain/loss, latest sync, and clear disconnected, empty, loading, and recoverable error states.

## Edge cases / handling

- OAuth callback denied/malformed/missing code: redirect to error state, no token persistence (IR-1/2).
- State replay, expiration, or concurrent attempts: consume one state record atomically; reject invalid attempt (IR-1).
- Token refresh race or expired refresh token: serialize per install; present reauthorization-required and retain snapshots (IR-3).
- Upstream 503/429: publish no partial snapshot, show recoverable error, and preserve history; empty race arrays succeed with no new rows and remain an empty-state view (IR-5/6).
- Duplicate or equal-time events: stable source event key prevents duplicates; timestamp, category, then event-key ordering stays deterministic (IR-5).
- No races / no history yet: return empty array and explain that first sync may have no available completed races (IR-6).
- Client credentials changed/removed: invalidate OAuth state and tokens; history remains unless explicit local data deletion is offered (IR-4).
- Callback URI mismatch or unavailable registrations: configuration reports actionable setup guidance; never fall back to fake auth (IR-1).

## End-to-end scenarios

Reuse Playwright compiled-app harness; use isolated DB and deterministic local upstream HTTP server, never mock RaceIQ routes or UI calls.

- E1 OAuth success and empty source: configure client through UI → complete fixture authorization → verify masked client secret, status redaction, and one-use state → sync empty array, then populated races; expect a connected account, empty-state handling, and successful refresh (IR-1/2/3/4/5/6).
- E2 OAuth failures: submit mismatched and missing state, then replay a successful callback; expect error redirects, no token for invalid attempts, and existing connection intact after replay (IR-1/2).
- E3 tracker: fixture returns two categories with positive/negative changes, an equal-time tie, and source records out of order → sync through UI → reopen page; expect exact stable history and category-separated changes; duplicate sync adds no rows (IR-5/6).
- E4 upstream and refresh failures: import history, return 503 then 429, then fail refresh; expect retryable errors, retained visible history, reauthorization-required, and history after refresh recovery (IR-3/5/6).
- E5 lifecycle: change client then disconnect; expect tokens removed, history retained; delete client; expect unconfigured/disconnected with no secrets (IR-2/3/4).
- E6 actual service: with registered client only, perform real iRacing authorization, callback, token refresh if eligible, and authenticated member endpoint request; record availability and result separately from deterministic local-upstream E2E evidence (IR-1/3/5). New registrations remain blocked by iRacing's published pause.

## Implementation plans

- [Backend implementation plan](irating-tracker-backend-plan.md)
- [UI implementation plan](irating-tracker-ui-plan.md)
