---
name: raceiq-online-worker-startup-handshake
description: Diagnose RaceIQ Online cached-account unavailable banner when the local Online worker times out awaiting its startup SQL lease handshake.
---

# RaceIQ Online worker startup handshake

## Observed failure and fix

On 2026-10-26, the Online branch displayed a cached connected account with local backend unavailable. `apps/backend/src/runtime/online-worker-entry.ts` awaited `initDbWorkerConnection()` at module scope. Parent logs showed `write-lease-acquire` received and `write-lease-granted` sent, but the worker did not process the grant. Its 30-second initialization deadline expired. An isolated worker probe did not reproduce the full-app failure; it was not sufficient verification.

Moving asynchronous initialization into `const start = async (): Promise<void> => { ... }`, then invoking `void start().catch(...)` after module evaluation, restored the real application. Retain the early parent message listener and database transport setup before invoking initialization. Report initialization rejection through the existing fatal channel. The startup worker in `apps/backend/src/runtime/startup-worker-entry.ts` provides an existing async-start pattern.

Use an arrow assigned after the `parentPort` null guard: a nested function declaration lost TypeScript's narrowing of captured `host`, producing TS18047 errors. Preserve worker SQL lease authority, shutdown, account credentials, and preferences; do not disable admission or increase the startup timeout to hide the failure.

## Verify

- Exercise actual development application, not only a standalone worker.
- `GET /api/online/state` must return 200 with truthful connection, service, and preference persistence state; do not dump tokens or account payloads.
- Existing targeted regression: `bun test apps/backend/test/e2e/dashboard-write-coordination.test.ts --test-name-pattern 'Online worker serves account state' --timeout 60000`.
- Run `bun run typecheck`; the fix affects captured-variable narrowing.
- Do not sign out, change sharing settings, accept policies, or consent to recording migrations merely to inspect availability.

## Online worktree startup

`RACEIQ_DEV_UDP_PORT=5302 bun run dev` successfully launched this worktree when 5301 was occupied. Check availability rather than assuming 5302 is always free. The launcher allocates backend HTTP dynamically and prints a worktree-specific Portless URL. In the observed worktree it was `http://online.raceiq-ec4c5a211f2502e4.localhost:1355/`; derive current URL from launcher output, not this historical value. Keep the owned service persistent when requested.

SpeedHQ containers may already be healthy. Inspect existing containers before recreating anything. The public API health endpoint observed was `https://raceiq.snazzie.space/healthz`, not `/health` or `/api/health`.
