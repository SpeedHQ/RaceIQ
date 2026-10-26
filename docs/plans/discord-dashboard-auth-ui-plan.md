# Discord dashboard authentication: UI plan

## Contract and scope

Implement the agreed [shared contract](discord-dashboard-auth-contract.md), owning DA-01/07 and UI portions of DA-02/05/08. The user requires password protection and Discord/offline choice on the same screen: choosing Discord replaces dashboard password setup with Discord sign-in. The coordinator owns the contract and final integration. UI can develop against the exact contract while backend implementation proceeds independently; no fake production fallback is allowed.

Owned scope: `client/src/components/onboarding/`, security components, login/onboarding routes, `client/src/lib/dashboard-auth.ts` if needed, client auth RPC consumers, supported locale messages and targeted frontend/browser tests. Preserve existing Home changes and all Online package files except through an agreed interface; reuse the exported Online choice cards. Backend owns new auth routes and method status field. Avoid broad redesign or unrelated settings changes.

## Tasks

1. Replace the separate access and account-choice screens with one account-choice screen. Show existing password/unprotected controls only for offline selection. Keep validation, explicit exposure warning, language persistence, Back/Continue and resume navigation coherent. Remove the obsolete standalone step and migrate all affected consumers/tests.
2. Discord selection starts the contracted auth flow without submitting a password or temporarily selecting unprotected access. Callback return finishes browser-bound authentication, refreshes auth state and continues onboarding using the already connected Online account; no second Discord prompt.
3. Login and access settings reflect `status.method`. Discord-protected sessions present Discord sign-in, not a dashboard-password form. Preserve managed environment overrides, offline password behavior, error/cancel/retry handling and explicit local logout.
4. Reuse existing components and translations. Add all required messages in every supported locale. Preserve keyboard labels/focus, responsive layout, loading and actionable error states. Migrate existing behavior tests at appropriate seams.

## Edge handling

The shared contract defines identity/security behavior. UI must handle pending setup, existing Online installations, callback reload, wrong account, expired/canceled/replayed completion, unavailable backend/provider and preserved protection after sign-out. Show no authenticated data until backend confirms the browser session. DA-05/DE-05 cover short/mismatched passwords, no-password warning and overrides. DA-07/DE-01/05 cover resume and desktop/390px keyboard-accessible layout. Do not clear existing recordings/settings or convert a failure into offline mode.

## Verification and completion

The coordinator runs shared DE-01–06 through the actual app and backend; UI maps DA-01 to DE-01/05, DA-02 to DE-01, DA-05 to DE-02/04/05, DA-07 to DE-01/05 and DA-08 to DE-06. Inspect meaningful states in one reused browser surface, including 390px. Run applicable regression suites and root `bun run typecheck`; record exact E2E outcomes and any blocked external service. Component mocks may support development but never substitute for integration evidence. Workers skip builds/tests/lint/formatters mid-flight. No commits or checkpoint files.

## Development-isolation integration

DA-09/DE-07 in the shared contract additionally require the same source-development onboarding screen to handle unavailable local Online services without reaching production or silently selecting an unprotected mode. Backend owns transport policy and DA-10/DE-08; UI must retain the offline choice and show the existing actionable unavailable/error state. Do not add direct production browser API calls or a fake successful Discord fallback.

Execution outcomes and remaining verification limits are recorded in the [shared verification record](discord-dashboard-auth-contract.md#verification-record). Passing Discord integration evidence does not replace the blocked offline regression scenarios.

## Shared-provider development setup

For the user-approved shared Supabase/Discord provider, DA-09/DE-07 permits explicitly configured hosted HTTPS authentication while the development application API uses its separate approved tunnel `https://raceiq-dev.snazzie.space`. Update unavailable-development copy across supported locales so it does not require the authentication provider itself to run locally. No new screen or authentication choice is needed. Verify the existing desktop sign-in button reaches the configured Discord provider, the public website uses the tunnel API rather than browser localhost, and provider callbacks preserve the originating development surface.
