# Discord dashboard authentication: backend plan

## Contract and scope

Implement the agreed [shared contract](discord-dashboard-auth-contract.md), including DA-02–06 and backend portions of DA-07/08. User explicitly selected Discord sign-in instead of a separate dashboard password whenever Discord is enabled. The coordinator owns contract changes and integration. Backend implementation is independent of UI work once the contract is fixed.

Owned scope: `apps/backend/src/runtime/dashboard-auth.ts`, `http-access.ts`, auth routes, Online integration/worker boundary, relevant `packages/online/server/` implementation/contracts, `server/db/schema.ts` and append-only migrations, backend and Online auth tests/fixtures. Preserve all pre-existing changes, especially `online-worker-entry.ts` and dashboard write-coordination tests. Do not alter the seed repair or UI files.

## Tasks

1. Reuse existing SDK OAuth, verified profile and installation-owner contracts. Keep provider credentials and account mutations server-side. Add bounded per-browser attempts and completion proof; never authenticate from global Online connection state alone.
2. Persist Discord protection without weakening DB corruption checks, configured-access marker, session generation, environment overrides or explicit local recovery. Existing verified Online users select Discord protection; sign-out/outage cannot downgrade it.
3. Implement the exact public operations and status shape in the shared contract. Bind OAuth to the initiating browser and validated callback origin. Enforce all real HTTP, mutation, Studio and WebSocket gates.
4. Connect initial successful Discord authentication to Online once; subsequent browser logins must not disconnect or switch the installation account. Preserve consent independence and single-user ownership.
5. Extend correct existing real-HTTP and worker/SDK regression seams; add minimal deterministic provider fixture only where necessary. Report runnable commands and any external redirect-allowlist prerequisite.

## Edge handling

The contract's state-transition section is authoritative. DA-06/DE-03 cover forged or replayed state, missing/stolen flow cookie, wrong owner, cancel/expiry/restart, parallel browsers and stale configuration. DA-04/DE-04 cover existing installations, unavailable provider/worker, sign-out and protected recovery. No failure grants access or silently picks offline/unprotected mode. Bound network calls and in-memory attempt count; do not log credentials.

## Verification and completion

The coordinator executes shared DE-01–06 against production handlers/integrations, plus focused backend/Online regressions and root `bun run typecheck`. Backend maps DA-02 to DE-01, DA-03/05 to DE-02/04/05, DA-04 to DE-04, DA-06 to DE-03, DA-07 to DE-01/05 and DA-08 to DE-06. Record passing outcomes or precise limitations; unexecuted E2E is not completion. Implementation workers must skip builds, tests, lint and formatters mid-flight and return exact changed paths and verification commands. No commits or checkpoint files.

## Additional development requirements

Implement DA-09/10 and shared DE-07/08 from the contract. A dedicated resolver slice owns `apps/backend/src/integrations/online-platform.ts` and its tests. SDK worker integrates disabled/local/production behavior, isolated credentials and outbound environment markers. A separate Cloud worker owns the server policy in `/Users/acoop/orca/projects/raceiq cloud/apps/raceiq`, plus local launch opt-in and focused Rust/HTTP tests. These are independent after the shared marker/policy contract; do not serialize them behind the UI. Coordinator owns cross-repository review, docs/changelog and final client/server verification. Preserve pre-existing Cloud changes and do not deploy.

Execution outcomes and remaining verification limits are recorded in the [shared verification record](discord-dashboard-auth-contract.md#verification-record). The coordinator owns final cross-layer evidence; the CLI side-effect regression remains explicitly unresolved.

## Shared-provider development instance

The user approved reusing the configured hosted Supabase and Discord provider for the isolated development instance. Follow updated DA-09/DE-07 in the shared contract. Preserve exact-origin transport, disabled defaults, isolated credentials and strict E2E validation. Explicit development API routing may use loopback or only `https://raceiq-dev.snazzie.space`; production and arbitrary remote API origins remain rejected. Extend resolver tests for that boundary. The Cloud launcher supports a non-conflicting API port and explicitly configured development public origin while retaining dedicated `data/dev` storage, loopback listeners and disabled Discord bot sends. A separate Cloudflare tunnel exposes API/website only; admin and metrics are excluded. The coordinator starts the real tunnel/stack, configures shared-provider redirects without replacing existing settings, and verifies public health, authenticated development read/write, blocked admin/metrics paths, Discord initiation and development callback return.
