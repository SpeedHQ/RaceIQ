# iRating Tracker — UI plan

Shared boundary: [iRacing OAuth and iRating Tracker Contract](irating-tracker-contract.md). UI uses contract-conforming fixtures until backend route is ready; fixtures do not replace production integration. Backend and UI can proceed independently after contract agreement. UI owns tracker and client presentation; backend owns route/service behavior; app composition owner wires real routes and runs cross-layer E2E.

## Scope

- Add iRating progression view on existing iRacing route (`client/src/routes/iracing/index.tsx`) or a nested route only if existing navigation conventions require it.
- Add settings to configure per-install OAuth client ID, secret, redirect URI via server APIs; secret is write-only and never enters React state after save or browser persistence.
- Use typed RPC client/TanStack Query and existing app controls/translations; no direct unmanaged fetch and no mock fallback in production.
- Show category-separated history, dated iRating and change, last sync, Connect/Sync/Disconnect actions, empty/disconnected/loading/error states.

## Tasks

1. Read route/RPC, Settings section and localized message patterns; reuse shared buttons/forms and message generation.
2. Implement safe write-only secret form with configured indicator and callback status handling.
3. Implement typed query/mutation hooks to contract routes; invalidate history/status after successful mutations.
4. Render category-specific history and accessible states; do not recompute backend rating deltas.
5. Add route-specific browser tests with contract fixtures, then run compiled app E1/E3–E5 against real backend routes.

## Acceptance / edge coverage

- IR-2 and IR-6, E1/E3–E5 in [shared contract](irating-tracker-contract.md).
- Disconnected state offers configuration/connect; empty connected state offers sync guidance; error state preserves visible prior data and retry; negative changes remain readable; category identity remains explicit.
- Secret is cleared from form state immediately after successful save and never repopulated from settings/status.

## Verification

Run `bun run typecheck` and `bun run i18n:check-keys`. Required completion gate is `E2E_SERVER_MODE=compiled PW_SERVER_SET=irating bunx playwright test --project=irating-tracker` from `playwright/` against compiled app, isolated database, and deterministic upstream HTTP fixture. E1–E5 cover real app/backend integration; mock-only component tests supplement but do not satisfy integration proof. Real iRacing OAuth requires registration credentials and is documented under E6 in the shared contract.
