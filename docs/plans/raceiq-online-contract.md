# RaceIQ Online UI/backend contract

Status: proposed local implementation contract based on confirmed product requirements, not an already implemented or verified interface. Version: 1. Change this document and both implementation plans together when a boundary changes.

Plans: [Backend and product requirements](raceiq-live-service.md) · [UI](raceiq-online-ui.md)
ADR: [Decision record](../adr/0011-raceiq-live-service.md)

## Boundary and ownership

“Backend” means the local RaceIQ Bun/Hono backend plus its adapter to the external RaceIQ Online service, not a redesign of that service. React never imports the live-service SDK, handles credentials, serializes recordings, or drives an upload queue. Local routes below are proposed RaceIQ routes; they are not claims about external service endpoints.

| Owner | Scope |
| --- | --- |
| Backend | Shared DTO definitions, local Hono routes/exported AppType, external v0.1.5 client adapter, OAuth/callback/secure tokens, consent persistence, preferences enforcement, account isolation, eligibility, F1 sanitization, durable outbox, unpublishing, leaderboard cache |
| UI | Onboarding/Settings/Community Laps, localized copy, accessibility, React Query hooks and Hono RPC adapter, fixture-only presentation scenarios |
| Integration owner | Freeze contract, review changes, validate production wiring and end-to-end privacy behavior; one editor for shared interfaces |

Existing conventions: `client/src/lib/rpc.ts` exports a Hono RPC client typed against `@raceiq/backend/routes/index`; client hooks use TanStack Query. Add shared definitions at proposed `shared/integrations/raceiq-online.ts`, exported through the shared workspace's existing export convention. Backend owns this shared file and package export changes. UI owns proposed `client/src/hooks/raceiq-online.ts` and `client/src/lib/raceiq-online.ts`. Use existing settings/onboarding/track composition; do not create a parallel account application.

## Non-negotiable semantics

- Offline features never depend on these routes or an Online session.
- Private means no recording/setup upload and no cloud validation. Public submits eligible fastest laps for service validation and potential leaderboard publication.
- Onboarding public draft defaults on but is not effective until explicitly confirmed. Setup attachment draft defaults off and requires an independent opt-in. Unconfirmed or unavailable preferences fail closed.
- Every uploaded F1 recording has embedded setup telemetry stripped, regardless of setup-attachment choice. Local originals stay intact. Unsafe/unsupported sanitization blocks submission with feedback. Optional setup attachments follow separate consent and game support; omitting an attachment is not F1 sanitization.
- Backend rechecks current account, accepted policy versions, effective public preference, and setup preference at dispatch. Private stops unsent work; setup-off omits subsequent attachments, including retry/backfill. Already-sent requests cannot be recalled. Backend owns supported unpublishing and exposes its progress/limitations.
- UI disabling a button is not enforcement. Backend rejects stale/unsafe commands and never trusts UI to authorize recording transfer.

## DTOs

The following TypeScript is the precise proposed DTO shape. All timestamps are UTC ISO-8601 strings; lap times are integer milliseconds; IDs are opaque strings. JSON contains no `undefined`, Date objects, tokens, cookies, email, Discord ID, local file paths, recording bytes, setup bytes, or unfiltered upstream errors. `userId` is the service's public opaque identity, not a Discord ID. Nullable fields are explicitly null.

```ts
type OnlineVisibility = "private" | "public";
type OnlinePreferences = { visibility: OnlineVisibility; setupUploads: boolean };
type PolicyVersions = { termsVersion: string; privacyVersion: string };
type OnlineErrorCode =
  | "offline" | "service_unavailable" | "policy_unavailable" | "policy_changed"
  | "not_connected" | "auth_failed" | "auth_cancelled" | "consent_required"
  | "stale_state" | "invalid_request" | "preferences_failed" | "rate_limited"
  | "unsupported_game" | "unknown_track" | "unknown_car" | "ineligible_lap"
  | "f1_sanitization_failed" | "validation_rejected" | "account_unavailable"
  | "unpublish_failed" | "external_open_failed" | "internal_error";
type OnlineError = {
  code: OnlineErrorCode;
  retryable: boolean;
  retryAfter: string | null;
};
type OnlineTransportError = {
  kind: "transport";
  code: "backend_unreachable" | "invalid_response";
  retryable: boolean;
};
type OnlinePolicy =
  | { status: "unavailable"; error: OnlineError | null }
  | { status: "available"; versions: PolicyVersions; termsUrl: string; privacyUrl: string };
type OnlineConnection =
  | { status: "signed_out" }
  | { status: "signing_in"; flowId: string }
  | { status: "connected"; account: { userId: string; displayName: string; avatarUrl: string | null } }
  | { status: "error"; error: OnlineError };
type OnlineConsent =
  | { status: "not_accepted" }
  | { status: "accepted"; versions: PolicyVersions; acceptedAt: string }
  | { status: "required"; previousVersions: PolicyVersions | null };
type OnlineSyncBlock =
  | "signed_out" | "consent_required" | "private" | "preferences_unconfirmed"
  | "offline" | "service_unavailable" | "account_unavailable";
type OnlineSync = {
  status: "idle" | "running" | "paused" | "blocked";
  blockedBy: OnlineSyncBlock | null;
  queued: number;
  inFlight: number;
  rejected: number;
  lastSyncedAt: string | null;
  lastError: OnlineError | null;
};
type OnlinePublication = {
  status: "none" | "pending" | "complete" | "failed" | "unavailable";
  error: OnlineError | null;
};
type OnlineState = {
  contractVersion: 1;
  revision: number;
  accountEpoch: string;
  service: "available" | "offline" | "unavailable";
  connection: OnlineConnection;
  policy: OnlinePolicy;
  consent: OnlineConsent;
  preferences: OnlinePreferences | null;
  persistedPreferences: OnlinePreferences | null;
  preferencePersistence: "unconfirmed" | "confirmed" | "pending" | "failed";
  uploadAllowed: boolean;
  sync: OnlineSync;
  publicationWithdrawal: OnlinePublication;
};
type OnlineMutationContext = { expectedRevision: number; accountEpoch: string };
type OnlineCommandResult =
  | { ok: true; state: OnlineState }
  | { ok: false; error: OnlineError; state: OnlineState };
type ConnectInput = OnlineMutationContext & {
  acceptedPolicyVersions: PolicyVersions;
  preferences: OnlinePreferences;
};
type ConnectResult =
  | { ok: true; state: OnlineState; authorizationUrl: string; flowId: string }
  | { ok: false; error: OnlineError; state: OnlineState };
type ConsentInput = OnlineMutationContext & { acceptedPolicyVersions: PolicyVersions };
type PreferencesInput = OnlineMutationContext & { preferences: OnlinePreferences };
type CancelSignInInput = OnlineMutationContext & { flowId: string };
type LeaderboardInput = { gameId: string; trackId: string; carId: string };
type OnlineLeaderboardRow = {
  rank: number;
  lapId: string;
  driver: { userId: string; displayName: string; avatarUrl: string | null };
  lapTimeMs: number;
};
type OnlineLeaderboard = {
  key: LeaderboardInput;
  status: "ready" | "empty" | "unavailable";
  rows: OnlineLeaderboardRow[];
  fetchedAt: string | null;
  stale: boolean;
  error: OnlineError | null;
};
interface RaceIqOnlinePort {
  getState(): Promise<OnlineState>;
  connect(input: ConnectInput): Promise<ConnectResult>;
  cancelSignIn(input: CancelSignInInput): Promise<OnlineCommandResult>;
  acceptConsent(input: ConsentInput): Promise<OnlineCommandResult>;
  setPreferences(input: PreferencesInput): Promise<OnlineCommandResult>;
  signOut(input: OnlineMutationContext): Promise<OnlineCommandResult>;
  getLeaderboard(input: LeaderboardInput): Promise<OnlineLeaderboard>;
}
```

State constraints: `preferences: null` means no confirmed account-specific preference, not public/default-on. `uploadAllowed` is authoritative backend capability derived from connected/current-consent/confirmed-public/service and local privacy barriers, never a persisted UI toggle or a test for nonempty queue. Eligibility and safe F1 sanitization are checked separately per job. `connected` is published only after callback validation, server consent acceptance, and preference persistence succeed. Retained credentials during re-consent never enable uploads. Policy unavailable/changed pauses transfers immediately. `sync.blockedBy` is non-null for blocked/paused states and null for idle/running. Zero counts are valid; counters are nonnegative and account-scoped. No queue/job admin screen is required; state supplies bounded status and actionable failure feedback.
Preference projection: `persistedPreferences` is the last service-confirmed pair for this account; `preferences` is the effective pair after durable restrictive local barriers. Both are null before an account has confirmed choices and after sign-out. `preferencePersistence` distinguishes unconfirmed/pending/failed persistence from confirmation; UI drafts are separate. Failed private/setup-off writes can therefore show effective private/setup-off alongside the older persisted pair without claiming service acknowledgement. Upload permission honors effective choices and unresolved privacy barriers, never the old persisted pair alone.

`accountEpoch` changes on connect attempt, sign-out, switch, account deletion/unavailability, and backend restart. `revision` increases on any state change within an epoch. Mutations compare both fields; stale context returns `stale_state` without permissive side effects. Restrictive same-account requests (private, setup-off, sign-out) install their local barrier even when only revision is stale; a wrong epoch cannot mutate another account. Backend serializes conflicting mutations. UI tracks request generations and invalidates old requests on account transition, rather than sorting opaque epoch strings; apply monotonic revisions only within the current epoch. Old-account responses must not hydrate state after sign-out/switch. Refresh after `stale_state`; never automatically replay consent or public/setup enablement.

## Local API mapping

All routes use the existing Hono RPC transport. No raw client fetch and no external service calls from React. Local transport security (trusted origin, OAuth state/PKCE, fixed callback destination, protected mutations) remains backend-owned; do not expose a remotely controllable upload or OAuth surface.

| Local route | Input | Success | Purpose |
| --- | --- | --- | --- |
| `GET /api/online/state` | None | 200 OnlineState | Public policy metadata, connection/consent/preferences/sync snapshot |
| `POST /api/online/connect` | ConnectInput | 202 ConnectResult | Start validated Discord flow after explicit policy/preferences confirmation |
| `POST /api/online/connect/cancel` | CancelSignInInput | 200 OnlineCommandResult | Invalidate pending flow; reject late callback |
| `PUT /api/online/consent` | ConsentInput | 200 OnlineCommandResult | Persist acceptance of exact current versions; re-enable only if other gates pass |
| `PUT /api/online/preferences` | PreferencesInput | 200 OnlineCommandResult | Persist complete preference pair; enforce dispatch gating |
| `POST /api/online/sign-out` | OnlineMutationContext | 200 OnlineCommandResult | Stop dispatch, invalidate flows, clear local credentials/account-scoped state |
| `GET /api/online/leaderboard` | trackId/carId query; explicit `X-Game-Id` header | 200 OnlineLeaderboard | Resolve canonical identifiers; read/cache a specific game/track/car board |

`getLeaderboard` port input includes gameId; its production adapter sends that game through `X-Game-Id`. Never default a missing game or infer it from an asynchronously updated global store. Local opaque track/car identifiers are resolved by backend; unsupported/unmapped identifiers produce explicit errors, not a guessed board. Backend maps external ranked results to exact row DTOs; no emails/Discord IDs are returned. This read never starts uploads or changes consent/preferences. Private users can read a public leaderboard when policy/read rules permit; private is not equivalent to signed-out or network failure.

Command failures use the same discriminated result with current sanitized state: 400 invalid request, 401 not connected, 403 consent/account gate, 409 stale state/policy changed, 429 rate limited, 503 offline/service/policy unavailable, 500 internal failure. `preferences_failed` uses 503 for upstream availability failure and 500 otherwise. Frontend adapter checks response status and body through existing RPC helpers. Route-unreachable/invalid response rejects with a typed transport error; UI retains last confirmed state, marks transport failure, and does not fabricate a server-success DTO. Read responses can return valid stale cached rows with error/fetchedAt; no cache means unavailable + empty rows, never a false ready/empty success.

## Auth, consent, and preference transitions

1. Fetch public policy metadata without personal-data transfer. If authoritative current URLs/versions are unavailable, keep offline path usable and block Online connection. UI displays policy links plus public/setup disclosures and requires explicit confirmation; checking default public draft alone does not call backend.
2. `connect` conveys explicit policy acceptance intent and the complete draft preference pair before launching Discord. Backend validates current versions, binds the intent/preferences to a single-use auth flow, then returns only an allowlisted HTTPS provider authorization URL and opaque flowId. UI opens it externally through the app's existing supported external-link mechanism. Cancel/open failure calls cancelSignIn; no browser/native automation is implied by this plan.
3. Backend handles OAuth callback/state/PKCE and secure credentials. After authentication, record the confirmed consent against the correct account and persist preferences before emitting connected/uploadAllowed. If policy changed or either write fails, no backfill/transfer begins; show required/error state and permit retry/sign-out. Never infer acceptance from a callback or auto-accept new policy versions. Confirm provider-specific identity transfer disclosures before implementation.
4. UI observes completion through bounded state polling; no credentials/callback tokens pass through React. Cancel invalidates server flow; late callbacks cannot reconnect or upload. Expired sessions pause dispatch and expose actionable not-connected/error state. Re-consent uses current versions and explicit user confirmation, not an automatic retry.
5. Setting private durably installs a local dispatch barrier before waiting on the service preference write or acknowledging the command. A failed private change retains that barrier across restart; state reports failure and uploads remain blocked until explicitly resolved. Setup-off likewise durably suppresses subsequent attachments even if the upstream write fails. Restrictive changes in a mixed preference request take effect even if its enabling part fails; enabling either public or setup requires a current revision and successful persistence. Server-confirmed preferences plus reported dispatch barriers distinguish effective safety from pending/failed persistence; never optimistic-enable uploads.
6. Sign-out takes its local barrier immediately, invalidates pending OAuth flows and tokens, isolates/removes old-account view state, and stops future dispatch even if external revocation fails. Already transmitted requests may finish remotely; their callbacks cannot hydrate a new account. Existing-public-result withdrawal/deletion remain backend-controlled with truthful pending/failed/unavailable feedback.

## UI cache and feedback contract

- Query state on Online surfaces; bounded 2-second polling only while sign-in or active sync/withdrawal needs progress, 30-second polling for an idle visible Online settings surface, suspended when hidden/unmounted. Backend must independently enforce gates; polling is not correctness infrastructure.
- Query keys include accountEpoch for account-specific state/results and gameId/trackId/carId for leaderboard identity. Cancel/invalidate relevant queries on sign-out/switch; reject late-account responses. Preserve existing local/community queries.
- Initial loading, local backend unreachable, remote service unavailable, signed-out, consent-required, private, empty leaderboard, stale cached board, validation rejection, F1 sanitization failure, and unpublish limitation remain distinguishable. Private does not blank a legitimately readable public board.
- UI translates stable error codes using Paraglide. Retry guidance respects retryable/retryAfter. Do not surface raw exception text or claim successful validation from queue enqueue/submission alone.
- Manage Account is a fixed external link to `https://raceiq.snazzie.space/account`; profile/account administration is not a local command. Terms/Privacy links use validated authoritative policy URLs; do not hardcode unverified policy paths.

## Parallel implementation and merge gate

Backend first lands shared DTOs/export and confirms names match this document; no fake success handlers or production stubs. UI may implement presentation against the exact typed port and deterministic fixture scenarios before live route availability. Fixtures belong only to test/preview code and must not become runtime fallback or auth simulation. Backend implements real local Hono endpoints; UI then completes the production Hono RPC adapter against exported AppType. No `any` casts or raw fetch to bypass missing route types. This tiny type prerequisite is not a dependency on full auth/outbox implementation.

Independent ownership: UI edits client components/hooks/locales and preview fixtures; backend edits apps/backend composition, server modules/storage, shared contract/export, and SDK dependency. Backend supplies route/type availability; UI supplies fixture coverage and production adapter. Shared files (contract DTO/package exports/AppType composition) have a single backend editor. Contract changes require coordinated updates to both plans/consumers; do not independently invent enums/units/defaults or add endpoint aliases.

Integration acceptance: production adapter uses the real Hono routes; exact DTOs, units, errors, and account epochs agree; successful UI requests never manufacture backend state; offline capture is usable with backend Online features unavailable; private makes no recording/setup requests; setup-off omits attachment bytes; F1 outgoing payload has no embedded setup telemetry across backfill/new/retry while local recording stays unchanged; consent and account races fail closed; actual auth/policy/public submission/unpublishing/leaderboard surfaces are exercised before claiming completion. UI fixtures prove presentation only, not remote enforcement. Follow both plans' tests/runtime proof and root `bun run typecheck`; remaining service contract gates cannot be bypassed by mocks.
