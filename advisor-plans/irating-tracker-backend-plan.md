# iRating Tracker — backend plan

Shared boundary: [iRacing OAuth and iRating Tracker Contract](irating-tracker-contract.md). Backend owns OAuth, credentials, provider access, persistence, routes and service E2E fixtures. UI may proceed independently using contract-conforming fixtures. Integration owner: backend owns contract and callback routes; UI owner owns tracker UI; app composition owner wires routes and runs cross-layer E2E.

## Scope

- OAuth client configuration and token lifecycle using local OS keystore, `server/runtime/platform/keystore.ts`.
- Server callback URL derived from current application origin/listener; do not accept untrusted redirect targets.
- Auth state and persisted rating observations in SQLite using embedded migration and Drizzle schema.
- Typed Hono route group mounted from `apps/backend/src/routes/index.ts`.
- iRacing OAuth/Data API responses parsed at a narrow service boundary; no reliance on browser SDK or simulator-only telemetry.

## Tasks

1. Confirm OAuth package protocol behavior against current iRacing registration and `racedirector/iracing-data-api` implementation. Existing registration is paused, so accept per-install credentials for already-registered clients; use server-side Fetch/crypto implementation with PKCE, avoiding an unverified SDK runtime dependency.
2. Define state expiry, one-use handling, token storage, secret changes and disconnect as contract states.
3. Add schema + migration + idempotent source-keyed rating history queries. Preserve history on reconnect/disconnect.
4. Implement OAuth callback and protected API service with sanitized errors, timeout and atomic sync publication.
5. Mount typed routes and add route/integration tests with real isolated DB and local fixture HTTP server.
6. Provide host `openExternal` / redirect behavior through existing route behavior; no cross-origin OAuth escape.

## Acceptance / edge coverage

- IR-1–IR-5, E1–E5 in [shared contract](irating-tracker-contract.md). Invalid callback/state does not persist token; API failures do not replace history; repeat event IDs upsert rather than duplicate.
- IR-3: E1 forces immediate access-token expiry to exercise successful server-side refresh/rotation; E4 forces refresh failure, checks reauthorization-required, then restores upstream and verifies retained history.
- IR-4: client change/removal and disconnect exercise keystore boundary plus durable DB semantics.
- IR-5: parser tests reject malformed timestamps, unknown categories, and missing identity; E1 verifies empty payload and authenticated OAuth refresh; E3 verifies out-of-order and equal-time ordering plus idempotence; E4 verifies 503/429 failure does not replace history.

Run `bun test apps/backend/test/routes/iracing-rating-routes.test.ts` and `bun run typecheck`. Required completion gate is `E2E_SERVER_MODE=compiled PW_SERVER_SET=irating bunx playwright test --project=irating-tracker` from `playwright/` through actual HTTP + SQLite + fixture upstream. E6 live iRacing OAuth/API proof requires an already registered client and service availability; report separately, never claim success without execution.
