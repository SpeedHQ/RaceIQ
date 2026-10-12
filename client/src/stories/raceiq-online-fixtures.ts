import { raceIqAuthConfig } from "@speedhq/live-client";
import type { OnlineState, OnlineLeaderboard, OnlineCommandResult, RaceIqOnlinePort, OnlineError, OnlinePreferences, DisplayNameInput } from "@raceiq/shared/integrations/raceiq-online";

// Presentation fixtures only. Never imported by production components or adapters.
export const fixturePolicy = { termsVersion: "preview-terms-1", privacyVersion: "preview-privacy-1" };
export const signedOutFixture: OnlineState = {
  contractVersion: 1, revision: 1, accountEpoch: "preview-signed-out", service: "available",
  connection: { status: "signed_out" },
  policy: { status: "available", versions: fixturePolicy, termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy" },
  consent: { status: "not_accepted" }, preferences: null, persistedPreferences: null,
  preferencePersistence: "unconfirmed", uploadAllowed: false,
  sync: { status: "blocked", blockedBy: "signed_out", queued: 0, inFlight: 0, rejected: 0, lastSyncedAt: null, lastError: null },
  publicationWithdrawal: { status: "none", error: null },
};
export const publicFixture: OnlineState = {
  ...signedOutFixture, accountEpoch: "preview-account", connection: { status: "connected", account: { userId: "public-preview-driver", discordUsername: "ApexDriver2048", displayName: "Preview Driver", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" } },
  consent: { status: "accepted", versions: fixturePolicy, acceptedAt: "2026-10-12T12:00:00Z" },
  preferences: { visibility: "public", setupUploads: false }, persistedPreferences: { visibility: "public", setupUploads: false },
  preferencePersistence: "confirmed", uploadAllowed: true,
  sync: { ...signedOutFixture.sync, status: "idle", blockedBy: null },
};
export const privateFixture: OnlineState = {
  ...publicFixture, preferences: { visibility: "private", setupUploads: false }, persistedPreferences: { visibility: "private", setupUploads: false },
  uploadAllowed: false, sync: { ...publicFixture.sync, status: "blocked", blockedBy: "private" },
};
export const preferencesFailedFixture: OnlineState = {
  ...privateFixture, persistedPreferences: publicFixture.persistedPreferences, preferencePersistence: "failed",
  sync: { ...privateFixture.sync, lastError: { code: "preferences_failed", retryable: true, retryAfter: null } },
  publicationWithdrawal: { status: "unavailable", error: null },
};
export const consentRequiredFixture: OnlineState = {
  ...publicFixture, consent: { status: "required", previousVersions: fixturePolicy }, uploadAllowed: false,
  policy: { status: "available", versions: { termsVersion: "preview-terms-2", privacyVersion: "preview-privacy-2" }, termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy" },
  sync: { ...publicFixture.sync, status: "blocked", blockedBy: "consent_required" },
};
export const unavailableFixture: OnlineState = {
  ...signedOutFixture, service: "unavailable", policy: { status: "unavailable", error: { code: "policy_unavailable", retryable: true, retryAfter: null } },
  sync: { ...signedOutFixture.sync, blockedBy: "service_unavailable" },
};
export const connectedServiceUnavailableFixture: OnlineState = {
  ...publicFixture, service: "unavailable",
  sync: { ...publicFixture.sync, status: "blocked", blockedBy: "service_unavailable" },
};
export const connectedConsentRequiredUnavailableFixture: OnlineState = {
  ...consentRequiredFixture, service: "unavailable",
  policy: { status: "unavailable", error: { code: "policy_unavailable", retryable: true, retryAfter: null } },
  sync: { ...consentRequiredFixture.sync, status: "blocked", blockedBy: "service_unavailable" },
};
export const preferencesWithoutProfileFixture: OnlineState = {
  ...unavailableFixture,
  connection: { status: "error", error: { code: "account_unavailable", retryable: true, retryAfter: null } },
  preferences: { visibility: "private", setupUploads: true },
  persistedPreferences: { visibility: "private", setupUploads: true },
  preferencePersistence: "confirmed",
};
export const fixtureBoard: OnlineLeaderboard = {
  key: { gameId: "f1-2025", trackId: "preview-track", carId: "preview-car" }, status: "ready", stale: false,
  fetchedAt: "2026-10-12T12:00:00Z", error: null,
  rows: [{ rank: 1, lapId: "preview-lap-1", driver: { userId: "preview-driver-1", displayName: "Apex Driver", avatarUrl: null }, lapTimeMs: 91234 },
    { rank: 2, lapId: "preview-lap-2", driver: { userId: "preview-driver-2", displayName: "Long display name for responsive preview", avatarUrl: null }, lapTimeMs: 92567 }],
};
export interface FixtureOnlinePort extends RaceIqOnlinePort { completeSignIn(): OnlineState; }
export function createOnlineFixturePort(initial: OnlineState, options: { board?: OnlineLeaderboard; transportFailure?: boolean; commandFailure?: OnlineError; pending?: boolean; stateDelayMs?: number; onCall?: (method: keyof RaceIqOnlinePort, input?: unknown) => void } = {}): FixtureOnlinePort {
  let state = structuredClone(initial);
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
  function advance(update: Partial<OnlineState>): OnlineState {
    state = { ...state, ...update, revision: state.revision + 1 };
    return structuredClone(state);
  }
  function result(update: Partial<OnlineState>): OnlineCommandResult {
    if (options.commandFailure) return { ok: false, error: options.commandFailure, state: structuredClone(state) };
    return { ok: true, state: advance(update) };
  }
  function confirmedPreferences(preferences: OnlinePreferences): Partial<OnlineState> {
    return { preferences, persistedPreferences: preferences, preferencePersistence: "confirmed", uploadAllowed: preferences.visibility === "public" && state.connection.status === "connected" && state.consent.status === "accepted" };
  }
  return {
    async getState() {
      options.onCall?.("getState");
      if (options.pending) return new Promise<OnlineState>(() => {});
      const response = structuredClone(state);
      await new Promise<void>((resolve) => setTimeout(resolve, options.stateDelayMs ?? 150));
      if (options.transportFailure) throw { kind: "transport", code: "backend_unreachable", retryable: true };
      return response;
    },
    completeSignIn() {
      return advance({
        accountEpoch: "preview-flow",
        connection: { status: "connected", account: { userId: "preview-driver", displayName: "Preview Driver", avatarUrl: null } },
        consent: { status: "not_accepted" },
        preferences: null,
        persistedPreferences: null,
        preferencePersistence: "unconfirmed",
        uploadAllowed: false,
        sync: { ...state.sync, status: "blocked", blockedBy: "consent_required" },
      });
    },
    async connect(input) {
      options.onCall?.("connect", input);
      await wait();
      if (options.commandFailure) return { ok: false, error: options.commandFailure, state: structuredClone(state) };
      const authorizationUrl = new URL("/auth/v1/authorize", raceIqAuthConfig.supabaseUrl);
      authorizationUrl.searchParams.set("provider", "discord");
      authorizationUrl.searchParams.set("client_id", "preview");
      return { ok: true, state: advance({ accountEpoch: "preview-flow", connection: { status: "signing_in", flowId: "preview-flow-id" }, uploadAllowed: false, preferences: null, persistedPreferences: null, preferencePersistence: "unconfirmed" }), authorizationUrl: authorizationUrl.href, flowId: "preview-flow-id" };
    },
    async cancelSignIn(input) { options.onCall?.("cancelSignIn", input); await wait(); return result({ ...signedOutFixture, accountEpoch: "preview-cancelled" }); },
    async acceptConsent(input) { options.onCall?.("acceptConsent", input); await wait(); return result({ consent: { status: "accepted", versions: input.acceptedPolicyVersions, acceptedAt: "2026-10-12T12:00:00Z" } }); },
    async setPreferences(input) { options.onCall?.("setPreferences", input); await wait(); return result(confirmedPreferences(input.preferences)); },
    async setDisplayName(input: DisplayNameInput) {
      options.onCall?.("setDisplayName", input);
      await wait();
      if (options.commandFailure) return { ok: false, error: options.commandFailure, state: structuredClone(state) };
      if (state.connection.status !== "connected") return { ok: false, error: { code: "not_connected", retryable: false, retryAfter: null }, state: structuredClone(state) };
      return result({ connection: { ...state.connection, account: { ...state.connection.account, displayName: input.displayName } } });
    },
    async signOut(input) { options.onCall?.("signOut", input); await wait(); return result({ ...signedOutFixture, accountEpoch: "preview-sign-out" }); },
    async getLeaderboard(input) { options.onCall?.("getLeaderboard", input); await wait(); return { ...structuredClone(options.board ?? fixtureBoard), key: input }; },
  };
}
