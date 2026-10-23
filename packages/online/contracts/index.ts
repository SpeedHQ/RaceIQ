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
  | "unsupported_game" | "unknown_track" | "unknown_car" | "ineligible_lap" | "capture_active"
  | "driver_identity_required" | "mixed_driver_lap" | "activity_identity_ambiguous"
  | "activity_revision_conflict" | "activity_owner_conflict" | "lap_owner_conflict" | "lap_identity_conflict"
  | "f1_sanitization_failed" | "validation_rejected" | "account_unavailable"
  | "unsupported_recording_format" | "recording_too_large" | "recording_not_ready"
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
  lapGuid: string;
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
export type GameIdentityBinding = {
  id: string;
  gameId: string;
  sourceKind: string;
  nativeIdentity: string;
  confirmation: "native_verified" | "user_confirmed";
  revision: number;
};
export type DeliveryStatus =
  | "queued" | "preparing" | "uploading" | "retry_wait" | "blocked" | "ambiguous"
  | "accepted" | "rejected" | "withdrawn" | "superseded";
export type ValidationStatus = "not_requested" | "pending" | "validated" | "rejected" | "unavailable";
export type PublicationStatus = "not_requested" | "pending" | "public" | "withdrawn" | "failed" | "unavailable";
export type UploadItem = {
  id: string;
  kind: "lap" | "profile";
  gameId: string | null;
  lapId: number | null;
  lapGuid: string | null;
  trackId: string | null;
  carId: string | null;
  delivery: DeliveryStatus;
  admittedAt: string;
  updatedAt: string;
  settledAt: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  acceptedAt: string | null;
  remoteJobId: string | null;
  validation: ValidationStatus;
  publication: PublicationStatus;
  error: OnlineError | null;
  activityId: string | null;
  activityRevision: number | null;
};
export type UploadPage = {
  schemaVersion: 2;
  accountEpoch: string;
  items: UploadItem[];
  nextCursor: string | null;
  observedAt: string;
  stale: boolean;
};
export type MetricTotals = {
  laps: number;
  positiveLaps: number;
  validLaps: number;
  drivenSeconds: number;
  validSeconds: number;
  distanceMeters: number | null;
  sessionTypeSeconds: { practice: number; qualifying: number; race: number; unknown: number };
  sessionsWithDuration: number;
  sessionsWithoutDuration: number;
};
export type ProfileCoverage = {
  identity: "complete" | "partial";
  driverAttribution: "complete" | "partial";
  sessionDuration: "complete" | "partial" | "unavailable";
  distance: "complete" | "partial" | "unavailable";
};
export type ProfileActivityContribution = {
  schemaVersion: 2;
  activityId: string;
  lapGuids: string[];
  expectedRevision: number | null;
  contentHash: string;
  gameId: string;
  metrics: MetricTotals;
  cars: { gameId: string; nativeId: string; seconds: number; laps: number }[];
  tracks: { gameId: string; nativeId: string; seconds: number; laps: number }[];
  coverage: ProfileCoverage;
};
export type FavoriteEntity = { nativeId: string; name: string; seconds: number; laps: number };
export type DriverSummary = {
  metrics: MetricTotals;
  games: {
    gameId: string;
    metrics: MetricTotals;
    favoriteCar: FavoriteEntity | null;
    favoriteTrack: FavoriteEntity | null;
  }[];
};
export type LocalDriverContext = {
  basis: "positive_lap_time";
  other: { laps: number; seconds: number };
  mixed: { laps: number; seconds: number };
  unknown: { laps: number; seconds: number };
};
export type DriverSummaryResponse = {
  schemaVersion: 2;
  localRevision: number;
  generatedAt: string;
  summary: DriverSummary;
  coverage: ProfileCoverage;
  context: LocalDriverContext;
};
export type LegacyStatsSnapshot = {
  totalLaps: number;
  distanceMeters: number;
  drivingTimeSeconds: number;
  favoriteCar: string | null;
  favoriteGame: string | null;
  syncedAt: string;
};
export type OnlineProfileResponse = {
  accountEpoch: string;
  status: "signed_out" | "consent_required" | "syncing" | "ready" | "legacy_unverified" | "unavailable";
  localPending: number;
  heldAmbiguous: number;
  lastConfirmedAt: string | null;
  onlineRevision: number | null;
  summary: DriverSummary | null;
  coverage: ProfileCoverage;
  legacyStats: LegacyStatsSnapshot | null;
  error: OnlineError | null;
};
export type CommunityEntitlement =
  | { allowed: true; accountEpoch: string; onlineRevision: number }
  | { allowed: false; error: OnlineError };
export type GameIdentityCandidate = {candidateId:string;gameId:string;sourceKind:string;expiresAt:string};
export type DriverBindingInput = OnlineMutationContext & {
  candidateId:string;
  confirmedByUser:true;
};
export type DriverBindingsSnapshot = { revision: number; bindings: GameIdentityBinding[];candidates:GameIdentityCandidate[] };
export type UploadPageInput = OnlineMutationContext & { view: "queue" | "history"; cursor: string | null; limit: number };
export interface OnlineLocalPort {
  getDriverBindings(): Promise<DriverBindingsSnapshot>;
  setDriverBinding(input: DriverBindingInput): Promise<OnlineCommandResult>;
  getUploads(input: UploadPageInput): Promise<UploadPage>;
  getOnlineProfile(): Promise<OnlineProfileResponse>;
}
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
