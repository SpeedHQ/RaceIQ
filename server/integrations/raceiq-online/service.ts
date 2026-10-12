import { randomUUID } from "node:crypto";
import { createDesktopAuth, type DesktopSignInAttempt, type api } from "@speedhq/live-client";
import * as keystore from "../../runtime/platform/keystore";
import type {
  CancelSignInInput, ConnectInput, ConnectResult, ConsentInput, DisplayNameInput, LeaderboardInput, OnlineCommandResult,
  OnlineError, OnlineLeaderboard, OnlineMutationContext, OnlinePolicy, OnlineState, PolicyVersions,
  PreferencesInput, RaceIqOnlinePort,
} from "@raceiq/shared/integrations/raceiq-online";
import { createRaceIqOnlineAdapter, OnlineAdapterError } from "./adapter";
import { createBoardIdentifierResolver } from "./identifiers";
import { OnlineStateStorage } from "../../db/online-state-storage";

export interface OnlineServiceAdapter {
  getPolicy(): Promise<unknown>;
  getConsent(accessToken: string): Promise<api.ConsentState>;
  getLeaderboard(input: LeaderboardInput): Promise<{ status: "ready" | "empty"; rows: OnlineLeaderboard["rows"]; fetchedAt: string; stale: false }>;
  getMe(accessToken: string): Promise<{ userId: string; displayName: string; avatarUrl: string | null; discordUsername?: string | null }>;
  setDisplayName(displayName: string, accessToken: string): Promise<{ userId: string; displayName: string; avatarUrl: string | null; discordUsername?: string | null }>;
  acceptConsent(input: PolicyVersions, accessToken: string): Promise<{ acceptedAt: string }>;
  getPreferences(accessToken: string): Promise<unknown>;
  setPreferences(input: PreferencesInput["preferences"], accessToken: string): Promise<unknown>;
}
type OnlineAttempt = { attempt: DesktopSignInAttempt; epoch: string };
type ServiceOptions = { storage?: OnlineStateStorage; adapter?: Partial<OnlineServiceAdapter>; keystore?: typeof keystore };
const error = (code: OnlineError["code"], retryable = false): OnlineError => ({ code, retryable, retryAfter: null });
const sameVersions = (a: PolicyVersions, b: PolicyVersions) => a.termsVersion === b.termsVersion && a.privacyVersion === b.privacyVersion;
export type RaceIqOnlineService = RaceIqOnlinePort & { handleAuthCallback(url: string): Promise<boolean> };

export function createRaceIqOnlineService(options: ServiceOptions = {}): RaceIqOnlineService {
  const { getSecret, setSecret } = options.keystore ?? keystore;
  const storage = options.storage ?? new OnlineStateStorage();
  let persisted = storage.load();
  persisted.accountEpoch = randomUUID();
  persisted.revision = 0;
  storage.save(persisted);
  const redirectUri = `http://127.0.0.1:${Number(process.env.SERVER_PORT) || 3117}/api/online/auth/callback`;
  const auth = createDesktopAuth({ redirectUri });
  const attempts = new Map<string, OnlineAttempt>();
  let activeAccessToken: string | null = null;
  let activeUserId: string | null = null;
  let activeDiscordAccountName: string | null = null;
  let accessExpiresAt = 0;
  let connectedAccount: OnlineState["connection"] = { status: "signed_out" };
  let activeConsent: OnlineState["consent"] = { status: "not_accepted" };
  let activePreferences: PreferencesInput["preferences"] | null = persisted.preferences;
  let activePersistedPreferences: PreferencesInput["preferences"] | null = persisted.persistedPreferences;
  let adapter: OnlineServiceAdapter;
  let tokenRefresh: Promise<string | null> | null = null;
  const clearRefreshToken = async () => {
    if (await getSecret("raceiq-online-refresh")) await setSecret("raceiq-online-refresh", "");
    if (await getSecret("raceiq-online-refresh")) throw new Error();
  };
  const accessToken = async (): Promise<string | null> => {
    if (activeAccessToken && accessExpiresAt > Date.now() / 1000 + 60) return activeAccessToken;
    if (tokenRefresh) return tokenRefresh;
    const epoch = persisted.accountEpoch;
    tokenRefresh = (async () => {
      let refreshToken: string;
      try { refreshToken = await getSecret("raceiq-online-refresh") ?? ""; } catch { return null; }
      if (!refreshToken || epoch !== persisted.accountEpoch) return null;
      try {
        if (epoch !== persisted.accountEpoch || await getSecret("raceiq-online-refresh") !== refreshToken) return null;
        const session = await auth.refreshSession(refreshToken);
        if (epoch !== persisted.accountEpoch || await getSecret("raceiq-online-refresh") !== refreshToken) return null;
        if (persisted.profile && session.userId !== persisted.profile.userId) {
          activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
          return null;
        }
        await setSecret("raceiq-online-refresh", session.refreshToken);
        if (epoch !== persisted.accountEpoch || await getSecret("raceiq-online-refresh") !== session.refreshToken) return null;
        activeAccessToken = session.accessToken;
        activeUserId = session.userId;
        activeDiscordAccountName = session.discordAccountName;
        accessExpiresAt = session.expiresAt;
        return activeAccessToken;
      } catch {
        if (epoch === persisted.accountEpoch) {
          activeAccessToken = null;
          accessExpiresAt = 0;
          activeUserId = null;
        }
        return null;
      }
    })();
    try { return await tokenRefresh; } finally { tokenRefresh = null; }
  };
  const defaultAdapter = createRaceIqOnlineAdapter({
    baseUrl: "https://raceiq.snazzie.space",
    credentials: async () => {
      const token = await accessToken();
      return token ? { accessToken: token, consentAccepted: activeConsent.status === "accepted", discordAccountName: activeDiscordAccountName } : null;
    },
    identifiers: createBoardIdentifierResolver([]),
  }) as OnlineServiceAdapter;
  adapter = options.adapter ? { ...defaultAdapter, ...options.adapter } : defaultAdapter;
  let policy: OnlinePolicy = { status: "unavailable", error: error("policy_unavailable", true) };
  let service: OnlineState["service"] = "unavailable";
  let policyAt = 0;
  let policyRefresh: Promise<void> | null = null;
  const boardCache = new Map<string, OnlineLeaderboard>();
  let boardGeneration = 0;
  const revokeBoards = () => { boardGeneration++; boardCache.clear(); };
  const leaderboardAccessError = (): OnlineError | null => {
    if (connectedAccount.status !== "connected") return error("not_connected");
    if (activeConsent.status !== "accepted") return error("consent_required");
    const preferences = activePreferences
      ? { ...activePreferences, visibility: persisted.privacyBarrier ? "private" as const : activePreferences.visibility }
      : null;
    return persisted.preferencePersistence !== "confirmed" || preferences?.visibility !== "public"
      ? error("sharing_required") : null;
  };
  const save = () => { persisted.revision++; storage.save(persisted); };
  const snapshot = (): OnlineState => {
    const effectivePreferences = activePreferences
      ? {
          ...activePreferences,
          visibility: persisted.privacyBarrier ? "private" as const : activePreferences.visibility,
          setupUploads: persisted.setupBarrier ? false : activePreferences.setupUploads,
        }
      : null;
    const consent: OnlineState["consent"] = activeConsent.status === "accepted"
      ? activeConsent
      : persisted.consent
        ? { status: "required", previousVersions: { termsVersion: persisted.consent.termsVersion, privacyVersion: persisted.consent.privacyVersion } }
        : activeConsent;
    const credentialAligned = Boolean(activeAccessToken && accessExpiresAt > Date.now() / 1000 + 60
      && activeUserId && connectedAccount.status === "connected" && connectedAccount.account.userId === activeUserId
      && persisted.profile?.userId === activeUserId);
    const blockedBy = service === "offline" ? "offline" : service === "unavailable" ? "service_unavailable"
      : connectedAccount.status !== "connected" ? "signed_out"
      : !credentialAligned ? "account_unavailable"
      : consent.status !== "accepted" ? "consent_required"
      : persisted.preferencePersistence !== "confirmed" ? "preferences_unconfirmed"
      : effectivePreferences?.visibility !== "public" ? "private" : null;
    return structuredClone({
      contractVersion: 1, revision: persisted.revision, accountEpoch: persisted.accountEpoch, service,
      connection: connectedAccount, policy, consent, preferences: effectivePreferences, persistedPreferences: activePersistedPreferences,
      preferencePersistence: persisted.preferencePersistence, uploadAllowed: service === "available" && policy.status === "available" && credentialAligned && consent.status === "accepted" && persisted.preferencePersistence === "confirmed" && !persisted.privacyBarrier && effectivePreferences?.visibility === "public",
      sync: { status: blockedBy ? "blocked" : "idle", blockedBy, queued: 0, inFlight: 0, rejected: 0, lastSyncedAt: null, lastError: null },
      publicationWithdrawal: { status: "none", error: null },
    });
  };
  const failure = (code: OnlineError["code"], retryable = false): OnlineCommandResult => ({ ok: false, error: error(code, retryable), state: snapshot() });
  const stale = (ctx: OnlineMutationContext) => ctx.accountEpoch !== persisted.accountEpoch || ctx.expectedRevision !== persisted.revision;
  const refreshPolicy = async () => {
    if (Date.now() - policyAt < 30_000) return;
    if (policyRefresh) return policyRefresh;
    policyRefresh = (async () => {
      try {
        const current = await adapter.getPolicy();
        if (!current || typeof current !== "object" || !("available" in current) || current.available !== true || !("termsVersion" in current) || typeof current.termsVersion !== "string" || !("privacyVersion" in current) || typeof current.privacyVersion !== "string" || !("termsUrl" in current) || typeof current.termsUrl !== "string" || !("privacyUrl" in current) || typeof current.privacyUrl !== "string") throw new Error();
        const versions = { termsVersion: current.termsVersion, privacyVersion: current.privacyVersion };
        const next: OnlinePolicy = { status: "available", versions, termsUrl: current.termsUrl, privacyUrl: current.privacyUrl };
        const changed = JSON.stringify(policy) !== JSON.stringify(next);
        policy = next; service = "available"; policyAt = Date.now();
        if (persisted.consent && !sameVersions(persisted.consent, next.versions)) {
          persisted.privacyBarrier = true; persisted.setupBarrier = true;
          activeConsent = { status: "required", previousVersions: { termsVersion: persisted.consent.termsVersion, privacyVersion: persisted.consent.privacyVersion } };
          save();
        } else {
          if (persisted.consent) activeConsent = { status: "accepted", versions: { termsVersion: persisted.consent.termsVersion, privacyVersion: persisted.consent.privacyVersion }, acceptedAt: persisted.consent.acceptedAt };
          if (changed) save();
        }
      } catch (cause) {
        const adapterFailure = cause instanceof OnlineAdapterError ? cause : null;
        const unavailablePolicy = adapterFailure?.code === "policy_unavailable" && !adapterFailure.retryable;
        const next: OnlinePolicy = {
          status: "unavailable",
          error: { code: "policy_unavailable", retryable: adapterFailure?.retryable ?? true, retryAfter: adapterFailure?.retryAfter ?? null },
        };
        const nextService = unavailablePolicy ? "available" : adapterFailure?.code === "offline" ? "offline" : "unavailable";
        policy = next; service = nextService; policyAt = Date.now();
      }
    })();
    try { await policyRefresh; } finally { policyRefresh = null; }
  };
  const hydrateConsent = async (token: string, epoch: string, userId: string) => {
    const revision = persisted.revision;
    try {
      const result = await adapter.getConsent(token);
      if (epoch !== persisted.accountEpoch || revision !== persisted.revision || activeAccessToken !== token || activeUserId !== userId
        || persisted.profile?.userId !== userId || connectedAccount.status !== "connected"
        || connectedAccount.account.userId !== userId) return;
      const acceptance = result.currentAcceptance;
      if (!acceptance || typeof acceptance.acceptedAt !== "string"
        || typeof acceptance.termsVersion !== "string" || typeof acceptance.privacyVersion !== "string") {
        if (persisted.consent !== null) {
          persisted.consent = null;
          save();
        }
        activeConsent = { status: "not_accepted" };
        return;
      }
      const acceptedVersions = { termsVersion: acceptance.termsVersion, privacyVersion: acceptance.privacyVersion };
      const priorConsent = JSON.stringify(persisted.consent);
      if (result.accepted && policy.status === "available" && sameVersions(acceptedVersions, policy.versions)) {
        persisted.consent = { ...acceptedVersions, acceptedAt: acceptance.acceptedAt };
        activeConsent = { status: "accepted", versions: acceptedVersions, acceptedAt: acceptance.acceptedAt };
      } else if (!result.accepted && policy.status === "available" && sameVersions(acceptedVersions, policy.versions)) {
        persisted.consent = null;
        activeConsent = { status: "not_accepted" };
      } else {
        persisted.consent = { ...acceptedVersions, acceptedAt: acceptance.acceptedAt };
        activeConsent = { status: "required", previousVersions: acceptedVersions };
      }
      if (priorConsent !== JSON.stringify(persisted.consent)) save();
    } catch {
      if (epoch === persisted.accountEpoch && revision === persisted.revision && activeAccessToken === token && activeUserId === userId
        && persisted.profile?.userId === userId) {
        activeConsent = { status: "required", previousVersions: persisted.consent
          ? { termsVersion: persisted.consent.termsVersion, privacyVersion: persisted.consent.privacyVersion } : null };
      }
    }
  };
  const hydratePreferences = async (token: string, epoch: string, userId: string) => {
    // A remote read must not undo a pending or failed local privacy restriction.
    if (activeConsent.status !== "accepted" || persisted.preferencePersistence === "pending" || persisted.preferencePersistence === "failed") return;
    const revision = persisted.revision;
    try {
      const result = await adapter.getPreferences(token);
      if (epoch !== persisted.accountEpoch || revision !== persisted.revision || activeAccessToken !== token || activeUserId !== userId
        || persisted.profile?.userId !== userId || connectedAccount.status !== "connected"
        || connectedAccount.account.userId !== userId || activeConsent.status !== "accepted") return;
      if (!result || typeof result !== "object" || !("visibility" in result) || (result.visibility !== "public" && result.visibility !== "private")
        || !("setupUploads" in result) || typeof result.setupUploads !== "boolean") return;
      const preferences: PreferencesInput["preferences"] = { visibility: result.visibility, setupUploads: result.setupUploads };
      if (JSON.stringify(activePreferences) === JSON.stringify(preferences)
        && JSON.stringify(activePersistedPreferences) === JSON.stringify(preferences)
        && persisted.preferencePersistence === "confirmed"
        && persisted.privacyBarrier === (preferences.visibility !== "public")
        && persisted.setupBarrier === !preferences.setupUploads) return;
      if (preferences.visibility === "private") revokeBoards();
      activePreferences = preferences; activePersistedPreferences = preferences;
      persisted.preferences = preferences; persisted.persistedPreferences = preferences;
      persisted.preferencePersistence = "confirmed";
      persisted.privacyBarrier = preferences.visibility !== "public";
      persisted.setupBarrier = !preferences.setupUploads;
      save();
    } catch { /* Keep local choices; missing Live confirmation remains fail-closed. */ }
  };
  return {
    async getState() {
      await refreshPolicy();
      const epoch = persisted.accountEpoch;
      const token = await accessToken();
      // Durable identity survives keystore outages; remote access still requires aligned live credentials.
      if (persisted.accountEpoch === epoch && persisted.profile && connectedAccount.status === "signed_out") {
        connectedAccount = { status: "connected", account: persisted.profile };
      }
      if (persisted.accountEpoch === epoch && token && activeUserId && connectedAccount.status !== "signing_in") {
        try {
          const profile = await adapter.getMe(token);
          if (persisted.accountEpoch !== epoch) return snapshot();
          if (activeUserId !== profile.userId) {
            activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
            connectedAccount = persisted.profile
              ? { status: "connected", account: persisted.profile }
              : { status: "signed_out" };
          } else {
            if (persisted.profile?.userId !== profile.userId) {
              persisted.profile = profile; persisted.preferences = null; persisted.persistedPreferences = null;
              persisted.consent = null; persisted.preferencePersistence = "unconfirmed";
              persisted.privacyBarrier = true; persisted.setupBarrier = true;
              activePreferences = null; activePersistedPreferences = null; activeConsent = { status: "not_accepted" };
              save();
            } else if (JSON.stringify(profile) !== JSON.stringify(persisted.profile)) {
              persisted.profile = profile; save();
            }
            connectedAccount = { status: "connected", account: profile };
            await hydrateConsent(token, epoch, profile.userId);
            await hydratePreferences(token, epoch, profile.userId);
          }
        } catch { /* Retain durable local identity and choices; remote ops require live credentials. */ }
      }
      return snapshot();
    },
    async connect(input: ConnectInput): Promise<ConnectResult> {
      if (stale(input)) return { ok: false, error: error("stale_state"), state: snapshot() };
      try {
        const attempt = await auth.beginSignIn();
        if (stale(input)) {
          attempt.cancel();
          return { ok: false, error: error("stale_state"), state: snapshot() };
        }
        await clearRefreshToken();
        for (const pending of attempts.values()) pending.attempt.cancel();
        revokeBoards();
        activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
        persisted.accountEpoch = randomUUID(); persisted.revision = 0;
        persisted.privacyBarrier = true; persisted.setupBarrier = true; persisted.preferencePersistence = "unconfirmed";
        activeConsent = { status: "not_accepted" };
        const flowId = randomUUID();
        attempts.set(flowId, { attempt, epoch: persisted.accountEpoch });
        setTimeout(() => {
          if (attempts.has(flowId)) {
            attempts.get(flowId)?.attempt.cancel();
            attempts.delete(flowId);
            if (connectedAccount.status === "signing_in" && connectedAccount.flowId === flowId) {
              connectedAccount = { status: "error", error: error("auth_failed") };
              try { save(); } catch { /* state remains fail-closed */ }
            }
          }
        }, 10 * 60_000);
        connectedAccount = { status: "signing_in", flowId };
        storage.save(persisted);
        return { ok: true, state: snapshot(), authorizationUrl: attempt.authorizationUrl, flowId };
      } catch {
        connectedAccount = { status: "error", error: error("auth_failed", true) };
        return { ok: false, error: error("auth_failed", true), state: snapshot() };
      }
    },
    async handleAuthCallback(url: string): Promise<boolean> {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return false; }
      const callback = new URL(redirectUri);
      if (parsed.origin !== callback.origin || parsed.pathname !== callback.pathname) return false;
      const found = [...attempts.entries()].find(([, value]) => value.epoch === persisted.accountEpoch);
      if (!found) return false;
      const [flowId, pending] = found;
      try {
        const session = await pending.attempt.complete(url);
        const clearPendingSession = async () => {
          if (pending.epoch !== persisted.accountEpoch) return;
          if (await getSecret("raceiq-online-refresh") === session.refreshToken) await setSecret("raceiq-online-refresh", "");
          if (activeAccessToken === session.accessToken) {
            activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
          }
        };
        if (pending.epoch !== persisted.accountEpoch || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== flowId) return false;
        activeAccessToken = session.accessToken; activeUserId = session.userId; accessExpiresAt = session.expiresAt;
        activeDiscordAccountName = session.discordAccountName;
        await setSecret("raceiq-online-refresh", session.refreshToken);
        if (pending.epoch !== persisted.accountEpoch || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== flowId
          || await getSecret("raceiq-online-refresh") !== session.refreshToken) {
          await clearPendingSession();
          return false;
        }
        const profile = await adapter.getMe(session.accessToken);
        if (profile.userId !== session.userId) throw new Error();
        if (pending.epoch !== persisted.accountEpoch || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== flowId) {
          await clearPendingSession();
          return false;
        }
        if (persisted.profile?.userId !== profile.userId) {
          activePreferences = null; activePersistedPreferences = null;
          persisted.consent = null; persisted.preferences = null; persisted.persistedPreferences = null;
          persisted.preferencePersistence = "unconfirmed";
        }
        persisted.profile = profile;
        persisted.privacyBarrier = true; persisted.setupBarrier = true;
        connectedAccount = { status: "connected", account: profile };
        await hydrateConsent(session.accessToken, pending.epoch, profile.userId);
        await hydratePreferences(session.accessToken, pending.epoch, profile.userId);
        if (pending.epoch !== persisted.accountEpoch || activeAccessToken !== session.accessToken || activeUserId !== profile.userId
          || connectedAccount.status !== "connected" || connectedAccount.account.userId !== profile.userId) {
          attempts.delete(flowId);
          return false;
        }
        save();
        attempts.delete(flowId);
        return true;
      } catch {
        attempts.delete(flowId);
        if (pending.epoch !== persisted.accountEpoch || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== flowId) return false;
        activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
        activeConsent = { status: "not_accepted" };
        connectedAccount = persisted.profile
          ? { status: "connected", account: persisted.profile }
          : { status: "error", error: error("auth_failed", true) };
        try { save(); } catch { /* State remains fail-closed. */ }
        return false;
      }
    },
    async cancelSignIn(input: CancelSignInInput) {
      if (stale(input)) return failure("stale_state");
      const pending = attempts.get(input.flowId);
      if (!pending || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== input.flowId) return failure("auth_cancelled");
      pending.attempt.cancel(); attempts.delete(input.flowId);
      connectedAccount = { status: "signed_out" };
      save();
      return { ok: true, state: snapshot() };
    },
    async acceptConsent(input: ConsentInput) {
      await refreshPolicy();
      if (stale(input)) return failure("stale_state");
      if (policy.status !== "available") return failure("policy_unavailable", true);
      if (!sameVersions(input.acceptedPolicyVersions, policy.versions)) return failure("policy_changed");
      if (connectedAccount.status !== "connected") return failure("not_connected");
      const epoch = persisted.accountEpoch;
      const userId = connectedAccount.account.userId;
      try {
        const token = await accessToken();
        if (!token || service !== "available" || activeUserId !== userId || persisted.profile?.userId !== userId) return failure("auth_failed", true);
        const acceptance = await adapter.acceptConsent(input.acceptedPolicyVersions, token);
        if (epoch !== persisted.accountEpoch || activeUserId !== userId || activeAccessToken !== token
          || connectedAccount.status !== "connected" || connectedAccount.account.userId !== userId) return failure("stale_state");
        persisted.consent = { ...input.acceptedPolicyVersions, acceptedAt: acceptance.acceptedAt };
        activeConsent = { status: "accepted", versions: input.acceptedPolicyVersions, acceptedAt: acceptance.acceptedAt };
        save();
        return { ok: true, state: snapshot() };
      } catch { return failure("auth_failed"); }
    },
    async setPreferences(input: PreferencesInput) {
      const wasStale = stale(input);
      if (input.accountEpoch !== persisted.accountEpoch) return failure("stale_state");
      if (input.preferences.visibility === "private") revokeBoards();
      const restrictive = input.preferences.visibility === "private" || !input.preferences.setupUploads;
      if (restrictive) {
        persisted.privacyBarrier ||= input.preferences.visibility === "private";
        persisted.setupBarrier ||= !input.preferences.setupUploads;
      }
      if (wasStale) {
        if (restrictive) {
          persisted.preferencePersistence = "pending";
          try { save(); } catch { return failure("preferences_failed"); }
        }
        return failure("stale_state");
      }
      persisted.preferencePersistence = "pending";
      try { save(); } catch { return failure("preferences_failed"); }
      if (connectedAccount.status !== "connected" || activeConsent.status !== "accepted") return failure("not_connected");
      const epoch = persisted.accountEpoch;
      const userId = connectedAccount.account.userId;
      try {
        if (service !== "available" || policy.status !== "available") return failure("service_unavailable", true);
        const token = await accessToken();
        if (!token || activeUserId !== userId || persisted.profile?.userId !== userId) return failure("auth_failed", true);
        await adapter.setPreferences(input.preferences, token);
        if (epoch !== persisted.accountEpoch || activeUserId !== userId || activeAccessToken !== token
          || connectedAccount.status !== "connected" || connectedAccount.account.userId !== userId) return failure("stale_state");
        activePreferences = input.preferences; activePersistedPreferences = input.preferences;
        persisted.preferences = input.preferences; persisted.persistedPreferences = input.preferences;
        persisted.preferencePersistence = "confirmed";
        persisted.privacyBarrier = input.preferences.visibility !== "public";
        persisted.setupBarrier = !input.preferences.setupUploads;
        save();
        return { ok: true, state: snapshot() };
      } catch {
        persisted.preferencePersistence = "failed";
        try { save(); } catch { /* restrictive barriers already persisted */ }
        return failure("preferences_failed");
      }
    },
    async setDisplayName(input: DisplayNameInput) {
      await refreshPolicy();
      if (stale(input)) return failure("stale_state");
      if (connectedAccount.status !== "connected") return failure("not_connected");
      if (policy.status !== "available") return failure("policy_unavailable", true);
      if (activeConsent.status !== "accepted" || !sameVersions(activeConsent.versions, policy.versions)) return failure("consent_required");
      const displayName = input.displayName.trim();
      let codePoints = 0;
      if (!displayName || /\p{Cc}/u.test(displayName)) return failure("invalid_request");
      for (const _character of displayName) if (++codePoints > 80) return failure("invalid_request");
      const epoch = persisted.accountEpoch;
      const userId = connectedAccount.account.userId;
      try {
        const token = await accessToken();
        if (!token || accessExpiresAt <= Date.now() / 1000 + 60 || stale(input) || persisted.accountEpoch !== epoch
          || activeUserId !== userId || persisted.profile?.userId !== userId || connectedAccount.status !== "connected"
          || connectedAccount.account.userId !== userId) return failure("auth_failed", true);
        const profile = await adapter.setDisplayName(displayName, token);
        if (stale(input) || persisted.accountEpoch !== epoch || activeAccessToken !== token
          || accessExpiresAt <= Date.now() / 1000 + 60 || activeUserId !== userId
          || persisted.profile?.userId !== userId || connectedAccount.status !== "connected"
          || connectedAccount.account.userId !== userId) return failure("stale_state");
        if (profile.userId !== userId || !profile.displayName.trim()) return failure("auth_failed");
        persisted.profile = profile;
        save();
        connectedAccount = { status: "connected", account: profile };
        return { ok: true, state: snapshot() };
      } catch (cause) {
        if (cause instanceof OnlineAdapterError) {
          switch (cause.code) {
            case "offline": return failure("offline", cause.retryable);
            case "service_unavailable": return failure("service_unavailable", cause.retryable);
            case "policy_unavailable": return failure("policy_unavailable", cause.retryable);
            case "policy_changed": return failure("policy_changed", cause.retryable);
            case "not_connected": return failure("not_connected");
            case "auth_failed": return failure("auth_failed", cause.retryable);
            case "rate_limited": return failure("rate_limited", cause.retryable);
            default: return failure("internal_error", cause.retryable);
          }
        }
        return failure("auth_failed");
      }
    },
    async signOut(input: OnlineMutationContext) {
      if (input.accountEpoch !== persisted.accountEpoch) return failure("stale_state");
      revokeBoards();
      attempts.clear();
      persisted.accountEpoch = randomUUID();
      persisted.revision++;
      persisted.profile = null; persisted.preferences = null; persisted.persistedPreferences = null; persisted.consent = null;
      persisted.preferencePersistence = "unconfirmed"; persisted.privacyBarrier = true; persisted.setupBarrier = true;
      connectedAccount = { status: "signed_out" }; activeConsent = { status: "not_accepted" };
      activePreferences = null; activePersistedPreferences = null;
      activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
      let clearFailed = false;
      try { storage.save(persisted); } catch { clearFailed = true; }
      try { await clearRefreshToken(); } catch { clearFailed = true; }
      if (clearFailed) {
        connectedAccount = { status: "error", error: error("internal_error", true) };
        try { save(); } catch { /* in-memory account barrier remains */ }
        return failure("internal_error", true);
      }
      return { ok: true, state: snapshot() };
    },
    async getLeaderboard(input: LeaderboardInput): Promise<OnlineLeaderboard> {
      await refreshPolicy();
      const epoch = persisted.accountEpoch;
      const denied = leaderboardAccessError();
      if (denied) return { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: denied };
      if (service !== "available" || policy.status !== "available") {
        return { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: error(service === "offline" ? "offline" : service === "unavailable" ? "service_unavailable" : "policy_unavailable", true) };
      }
      const token = await accessToken();
      const key = JSON.stringify([input.gameId, input.trackId, input.carId]);
      const userId = activeUserId;
      if (epoch !== persisted.accountEpoch || !token || accessExpiresAt <= Date.now() / 1000 + 60
        || !userId || activeAccessToken !== token || service !== "available" || policy.status !== "available") {
        return { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: error("auth_failed", true) };
      }
      const accessDenied = leaderboardAccessError();
      if (accessDenied || persisted.profile?.userId !== userId || connectedAccount.status !== "connected" || connectedAccount.account.userId !== userId) return { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: accessDenied ?? error("auth_failed", true) };
      const generation = boardGeneration;
      const stillEntitled = () => generation === boardGeneration && epoch === persisted.accountEpoch
        && activeAccessToken === token && accessExpiresAt > Date.now() / 1000 + 60 && activeUserId === userId
        && persisted.profile?.userId === userId && connectedAccount.status === "connected"
        && connectedAccount.account.userId === userId && leaderboardAccessError() === null;
      try {
        const result = await adapter.getLeaderboard(input);
        if (!stillEntitled()) {
          const accessError = leaderboardAccessError() ?? error("sharing_required");
          return { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: accessError };
        }
        const board: OnlineLeaderboard = { key: input, ...result, error: null };
        if (!boardCache.has(key) && boardCache.size >= 100) {
          const oldest = boardCache.keys().next().value;
          if (oldest !== undefined) boardCache.delete(oldest);
        }
        boardCache.set(key, board);
        return structuredClone(board);
      } catch (cause) {
        const failure: OnlineError = cause instanceof OnlineAdapterError
          ? { code: cause.code === "invalid_response" ? "internal_error" : cause.code, retryable: cause.retryable, retryAfter: cause.retryAfter }
          : error("service_unavailable", true);
        if (!stillEntitled()) {
          return { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: leaderboardAccessError() ?? error("sharing_required") };
        }
        const cached = boardCache.get(key);
        return cached
          ? { ...structuredClone(cached), stale: true, error: failure }
          : { key: input, status: "unavailable", rows: [], fetchedAt: null, stale: false, error: failure };
      }
    },
  };
}

let singleton: RaceIqOnlineService | undefined;
export function getOnlineService(): RaceIqOnlineService {
  singleton ??= createRaceIqOnlineService();
  return singleton;
}
