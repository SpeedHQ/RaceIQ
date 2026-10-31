---
name: raceiq-consent-browser-restart-fixtures
description: "Verify RaceIQ cross-repo consent OAuth return and backend restart using the Cloud SPA harness, explicit dashboard no-login setup, and durable isolated test credentials."
---

# RaceIQ consent browser/restart verification

Use for cross-repository consent return, ownership recovery, or backend restart checks.

## Entry point

Cloud harness: `scripts/e2e-cloud-consent-spa.ts`. Run from the actual Cloud checkout with `RACEIQ_DESKTOP_REPO` pointing to desktop checkout and `RACEIQ_E2E_BROWSER_BINARY` pointing to its freshly built `dist/raceiq`. Rebuild with `bun run build:browser` after backend or SPA changes. Do not assume Cloud lives below the desktop checkout; paths may contain spaces.

## Fixture invariants

- Commit an actual controlled provider-origin HTML document and click its Continue link before OAuth callback. Immediate redirect-only providers do not prove browser referrer behavior.
- Preserve the provider code-to-PKCE-challenge/user mapping when adding the interactive document. Support issued refresh-token grants separately; reject unknown refresh tokens.
- Desktop E2E platform defaults to a per-process in-memory keystore. Restart cannot restore credentials with that default. For restart coverage, use the existing opt-in `RACEIQ_E2E_KEYSTORE_PATH` under the harness's temporary data directory. It is guarded by `RACEIQ_E2E=1` and `NODE_ENV=test`; never use real OS credentials. Clean up the temporary file.
- Explicit no-login dashboard setup uses supported `auth.setup(null, true)` followed by `auth.disable()`. Setup alone leaves the authentication-method row implicit; first owner claim can activate the legacy Discord fallback. Do not weaken middleware or directly patch auth rows to hide a 401.
- Read local state through same-origin browser fetch; assert HTTP status before inspecting JSON. On failure, collect bounded `/api/auth/status` fields and page URL, not secrets.

## Required observations

Verify exact sanitized Settings/onboarding URL, matching consent referrer origin, no transient marker/auth-secret leakage, owner persistence, and account isolation. Exercise cancellation followed by new OAuth and acceptance.

For restart, clear integration trace before stopping the backend. After restart require a new successful credential-backed `/api/v1/me` request, not merely cached `connection.status === 'connected'` or an existing owner row. Cached identity can falsely satisfy those assertions without live authorization.

The same-tab harness does not independently prove the UI popup launcher or split SPA/API-origin matrix. Report those limits when not exercised. A passing deletion scenario inside `e2e:cloud-consent` does not make the full command pass if a later unrelated leaderboard scenario fails.
