---
name: raceiq-cloud-consent-e2e-redirect-loop
description: "Diagnose RaceIQ Cloud e2e:cloud-consent failures after consent PUT 200, redirect loops, lost return targets, or SQLite transaction/lock 503s."
---

# Cloud consent e2e: return loop / lost target

Run from the Cloud checkout: `bun --no-env-file run e2e:cloud-consent` (about 15–80s). Failure-only diagnostics in `scripts/e2e-cloud-consent.ts` print PUT statuses, consent endpoint method/status sequence, page URL/body, cached return target, and a direct `/me/consent` probe with a 2s timeout.

## Known causes and contracts

1. **Account ↔ `/flows/consent` loop after PUT 200:** stale route state redirected before the session's consent GET started. Gate on `consentSettledFor === session.access_token` in `apps/account-website/src/ui/SiteHeader.tsx`.
2. **Null browser return target:** expected when `SiteHeader` clears `browserReturnKey` on non-consent paths or consent URL lacks `?browserReturnTo=`. Fix the fixture: re-enter consent through loopback `/source` before Confirm. Do not weaken URL/origin validation.
3. **Public leaderboard 404 stall:** consume response body before continuing.
4. **CC-05:** disabled policy requires `GET /me/consent` to return `503 CONSENT_POLICY_UNAVAILABLE` (contract BC-04), not `200` with `available:false`.
5. **SQLite `database is locked` / `begin_with at non-zero transaction depth`:** observed downstream of cancelled requests; exact trigger remains unconfirmed. `.before_acquire` in `SqlitePoolOptions` (`apps/raceiq/src/db.rs`) pings and drops dirty connections. Diagnose the loop first; do not assert a proven root cause without evidence.

## Gotchas

- `cargo test --manifest-path apps/raceiq/Cargo.toml` (no root `Cargo.toml`). A prior `client_environment.rs:98` compile error was pre-existing; verify current checkout before attributing it.
- Running heavy suites concurrently caused spurious 5s/10s timeouts in retention and dashboard-auth CLI tests. Rerun alone before diagnosing timing failures.
