export type OnlineVisibility = "private" | "public";
export interface OnlineKeystore {
  getSecret(key: string): Promise<string>;
  setSecret(key: string, value: string): Promise<void>;
}
export type OnlinePreferences = { visibility: OnlineVisibility; setupUploads: boolean };
export type PolicyVersions = { termsVersion: string; privacyVersion: string };
export type OnlineErrorCode =
  | "offline" | "service_unavailable" | "policy_unavailable" | "policy_changed"
  | "not_connected" | "auth_failed" | "auth_cancelled" | "consent_required"
  | "stale_state" | "invalid_request" | "preferences_failed" | "sharing_required" | "rate_limited"
  | "unsupported_game" | "unknown_track" | "unknown_car" | "ineligible_lap"
  | "f1_sanitization_failed" | "validation_rejected" | "account_unavailable"
  | "unpublish_failed" | "external_open_failed" | "internal_error";
export type OnlineError = {
  code: OnlineErrorCode;
  retryable: boolean;
  retryAfter: string | null;
};
export type OnlineTransportError = {
  kind: "transport";
  code: "backend_unreachable" | "invalid_response";
  retryable: boolean;
};
export type OnlinePolicy =
  | { status: "unavailable"; error: OnlineError | null }
  | { status: "available"; versions: PolicyVersions; termsUrl: string; privacyUrl: string };
export type OnlineConnection =
  | { status: "signed_out" }
  | { status: "signing_in"; flowId: string }
  | { status: "connected"; account: { userId: string; displayName: string; avatarUrl: string | null; discordUsername?: string | null } }
  | { status: "error"; error: OnlineError };
export type OnlineConsent =
  | { status: "not_accepted" }
  | { status: "accepted"; versions: PolicyVersions; acceptedAt: string }
  | { status: "required"; previousVersions: PolicyVersions | null };
export type OnlineSyncBlock =
  | "signed_out" | "consent_required" | "private" | "preferences_unconfirmed"
  | "offline" | "service_unavailable" | "account_unavailable";
export type OnlineSync = {
  status: "idle" | "running" | "paused" | "blocked";
  blockedBy: OnlineSyncBlock | null;
  queued: number;
  inFlight: number;
  rejected: number;
  lastSyncedAt: string | null;
  lastError: OnlineError | null;
};
export type OnlinePublication = {
  status: "none" | "pending" | "complete" | "failed" | "unavailable";
  error: OnlineError | null;
};
export type OnlineState = {
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
export type OnlineMutationContext = { expectedRevision: number; accountEpoch: string };
export type OnlineCommandResult =
  | { ok: true; state: OnlineState }
  | { ok: false; error: OnlineError; state: OnlineState };
export type ConnectInput = OnlineMutationContext;
export type ConnectResult =
  | { ok: true; state: OnlineState; authorizationUrl: string; flowId: string }
  | { ok: false; error: OnlineError; state: OnlineState };
export type ConsentInput = OnlineMutationContext & { acceptedPolicyVersions: PolicyVersions };
export type DisplayNameInput = OnlineMutationContext & { displayName: string };
export type PreferencesInput = OnlineMutationContext & { preferences: OnlinePreferences };
export type CancelSignInInput = OnlineMutationContext & { flowId: string };
export type LeaderboardInput = { gameId: string; trackId: string; carId: string };
export type OnlineLeaderboardRow = {
  rank: number;
  lapId: string;
  driver: { userId: string; displayName: string; avatarUrl: string | null };
  lapTimeMs: number;
  importAvailable: boolean;
};
export type OnlineLeaderboard = {
  key: LeaderboardInput;
  status: "ready" | "empty" | "unavailable";
  rows: OnlineLeaderboardRow[];
  fetchedAt: string | null;
  stale: boolean;
  error: OnlineError | null;
};
export interface RaceIqOnlinePort {
  getState(): Promise<OnlineState>;
  connect(input: ConnectInput): Promise<ConnectResult>;
  cancelSignIn(input: CancelSignInInput): Promise<OnlineCommandResult>;
  acceptConsent(input: ConsentInput): Promise<OnlineCommandResult>;
  setPreferences(input: PreferencesInput): Promise<OnlineCommandResult>;
  setDisplayName(input: DisplayNameInput): Promise<OnlineCommandResult>;
  signOut(input: OnlineMutationContext): Promise<OnlineCommandResult>;
  getLeaderboard(input: LeaderboardInput): Promise<OnlineLeaderboard>;
}
