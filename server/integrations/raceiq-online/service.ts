import { randomUUID } from "node:crypto";
import { createDesktopAuth, type DesktopSignInAttempt } from "@speedhq/live-client";
import { getSecret, setSecret } from "../../runtime/platform/keystore";
import type {
  CancelSignInInput, ConnectInput, ConnectResult, ConsentInput, LeaderboardInput, OnlineCommandResult,
  OnlineError, OnlineLeaderboard, OnlineMutationContext, OnlinePolicy, OnlineState, PolicyVersions,
  PreferencesInput, RaceIqOnlinePort,
} from "@raceiq/shared/integrations/raceiq-online";
import { createRaceIqOnlineAdapter, OnlineAdapterError } from "./adapter";
import { createBoardIdentifierResolver } from "./identifiers";
import { OnlineStateStorage } from "../../db/online-state-storage";

export interface OnlineServiceAdapter {
  getPolicy(): Promise<unknown>;
  getLeaderboard(input: LeaderboardInput): Promise<{ status: "ready" | "empty"; rows: OnlineLeaderboard["rows"]; fetchedAt: string; stale: false }>;
  getMe(accessToken: string): Promise<{ userId: string; displayName: string; avatarUrl: string | null }>;
  acceptConsent(input: PolicyVersions, accessToken: string): Promise<{ acceptedAt: string }>;
  setPreferences(input: PreferencesInput["preferences"], accessToken: string): Promise<unknown>;
}

type OnlineAttempt = { attempt: DesktopSignInAttempt; input: ConnectInput; preferences: ConnectInput["preferences"]; epoch: string };
type ServiceOptions = { storage?: OnlineStateStorage; adapter?: Partial<OnlineServiceAdapter> };
const error = (code: OnlineError["code"], retryable = false): OnlineError => ({ code, retryable, retryAfter: null });
const sameVersions = (a: PolicyVersions, b: PolicyVersions) => a.termsVersion === b.termsVersion && a.privacyVersion === b.privacyVersion;
export type RaceIqOnlineService = RaceIqOnlinePort & { handleAuthCallback(url: string): Promise<boolean> };

export function createRaceIqOnlineService(options: ServiceOptions = {}): RaceIqOnlineService {
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
  let accessExpiresAt = 0;
  let connectedAccount: OnlineState["connection"] = { status: "signed_out" };
  let activeConsent: OnlineState["consent"] = { status: "not_accepted" };
  let activePreferences: PreferencesInput["preferences"] | null = null;
  let activePersistedPreferences: PreferencesInput["preferences"] | null = null;
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
      const refreshToken = await getSecret("raceiq-online-refresh");
      if (!refreshToken || epoch !== persisted.accountEpoch) return null;
      try {
        const session = await auth.refreshSession(refreshToken);
        if (epoch !== persisted.accountEpoch || await getSecret("raceiq-online-refresh") !== refreshToken) return null;
        await setSecret("raceiq-online-refresh", session.refreshToken);
        if (epoch !== persisted.accountEpoch || await getSecret("raceiq-online-refresh") !== session.refreshToken) return null;
        activeAccessToken = session.accessToken;
        activeUserId = session.userId;
        accessExpiresAt = session.expiresAt;
        return activeAccessToken;
      } catch {
        if (epoch === persisted.accountEpoch) {
          activeAccessToken = null;
          accessExpiresAt = 0;
          activeUserId = null;
          if (await getSecret("raceiq-online-refresh") === refreshToken) await setSecret("raceiq-online-refresh", "");
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
      return token ? { accessToken: token, consentAccepted: activeConsent.status === "accepted" } : null;
    },
    identifiers: createBoardIdentifierResolver([]),
  }) as OnlineServiceAdapter;
  adapter = options.adapter ? { ...defaultAdapter, ...options.adapter } : defaultAdapter;
  let policy: OnlinePolicy = { status: "unavailable", error: error("policy_unavailable", true) };
  let service: OnlineState["service"] = "unavailable";
  let policyAt = 0;
  let policyRefresh: Promise<void> | null = null;
  const boardCache = new Map<string, OnlineLeaderboard>();
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
    const blockedBy = service === "offline" ? "offline" : service === "unavailable" ? "service_unavailable"
      : connectedAccount.status !== "connected" ? "signed_out"
      : consent.status !== "accepted" ? "consent_required"
      : persisted.preferencePersistence !== "confirmed" ? "preferences_unconfirmed"
      : effectivePreferences?.visibility !== "public" ? "private" : null;
    return structuredClone({
      contractVersion: 1, revision: persisted.revision, accountEpoch: persisted.accountEpoch, service,
      connection: connectedAccount, policy, consent, preferences: effectivePreferences, persistedPreferences: activePersistedPreferences,
      preferencePersistence: persisted.preferencePersistence, uploadAllowed: connectedAccount.status === "connected" && consent.status === "accepted" && persisted.preferencePersistence === "confirmed" && effectivePreferences?.visibility === "public",
      sync: { status: "blocked", blockedBy, queued: 0, inFlight: 0, rejected: 0, lastSyncedAt: null, lastError: null },
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
          save();
        } else if (changed) save();
      } catch (cause) {
        const adapterFailure = cause instanceof OnlineAdapterError ? cause : null;
        const unavailablePolicy = adapterFailure?.code === "policy_unavailable" && !adapterFailure.retryable;
        const next: OnlinePolicy = {
          status: "unavailable",
          error: { code: "policy_unavailable", retryable: adapterFailure?.retryable ?? true, retryAfter: adapterFailure?.retryAfter ?? null },
        };
        const nextService = unavailablePolicy ? "available" : adapterFailure?.code === "offline" ? "offline" : "unavailable";
        const changed = JSON.stringify(policy) !== JSON.stringify(next) || service !== nextService;
        policy = next; service = nextService; policyAt = Date.now();
        if (persisted.consent || !persisted.privacyBarrier || !persisted.setupBarrier) {
          persisted.privacyBarrier = true; persisted.setupBarrier = true;
          try { save(); } catch { persisted.revision++; }
        } else if (changed) {
          try { save(); } catch { persisted.revision++; }
        }
      }
    })();
    try { await policyRefresh; } finally { policyRefresh = null; }
  };
  return {
    async getState() {
      await refreshPolicy();
      const epoch = persisted.accountEpoch;
      const token = await accessToken();
      if (!token && connectedAccount.status === "connected") {
        connectedAccount = { status: "error", error: error("auth_failed") };
        activeUserId = null;
      } else if (token && connectedAccount.status !== "connected" && activeUserId) {
        try {
          const profile = await adapter.getMe(token);
          if (persisted.accountEpoch === epoch && profile.userId === activeUserId) {
            connectedAccount = { status: "connected", account: profile };
            activePreferences = persisted.preferences;
            activePersistedPreferences = persisted.persistedPreferences;
            activeConsent = persisted.consent && policy.status === "available" && sameVersions(persisted.consent, policy.versions)
              ? { status: "accepted", versions: persisted.consent, acceptedAt: persisted.consent.acceptedAt }
              : persisted.consent
                ? { status: "required", previousVersions: { termsVersion: persisted.consent.termsVersion, privacyVersion: persisted.consent.privacyVersion } }
                : { status: "not_accepted" };
          }
        } catch {
          connectedAccount = { status: "error", error: error("auth_failed") };
          activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
        }
      }
      return snapshot();
    },
    async connect(input: ConnectInput): Promise<ConnectResult> {
      await refreshPolicy();
      if (stale(input)) return { ok: false, error: error("stale_state"), state: snapshot() };
      if (policy.status !== "available") return { ok: false, error: error("policy_unavailable", true), state: snapshot() };
      if (!sameVersions(input.acceptedPolicyVersions, policy.versions)) return { ok: false, error: error("policy_changed"), state: snapshot() };
      try {
        const attempt = await auth.beginSignIn();
        if (stale(input)) {
          attempt.cancel();
          return { ok: false, error: error("stale_state"), state: snapshot() };
        }
        await clearRefreshToken();
        for (const pending of attempts.values()) pending.attempt.cancel();
        attempts.clear();
        activeAccessToken = null; accessExpiresAt = 0;
        activeUserId = null;
        persisted.accountEpoch = randomUUID(); persisted.revision = 0;
        persisted.preferences = null; persisted.persistedPreferences = null; persisted.consent = null;
        persisted.privacyBarrier = true; persisted.setupBarrier = true; persisted.preferencePersistence = "unconfirmed";
        activePreferences = null; activePersistedPreferences = null; activeConsent = { status: "not_accepted" };
        const flowId = randomUUID();
        attempts.set(flowId, { attempt, input, preferences: input.preferences, epoch: persisted.accountEpoch });
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
      attempts.delete(flowId);
      try {
        const session = await pending.attempt.complete(url);
        if (pending.epoch !== persisted.accountEpoch || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== flowId) return false;
        await refreshPolicy();
        if (policy.status !== "available" || !sameVersions(pending.input.acceptedPolicyVersions, policy.versions)) throw new Error();
        activeAccessToken = session.accessToken; activeUserId = session.userId; accessExpiresAt = session.expiresAt;
        await setSecret("raceiq-online-refresh", session.refreshToken);
        if (await getSecret("raceiq-online-refresh") !== session.refreshToken) throw new Error();
        const profile = await adapter.getMe(session.accessToken);
        if (profile.userId !== session.userId) throw new Error();
        if (pending.epoch !== persisted.accountEpoch || connectedAccount.status !== "signing_in" || connectedAccount.flowId !== flowId) return false;
        const consent = await adapter.acceptConsent(pending.input.acceptedPolicyVersions, session.accessToken);
        if (pending.epoch !== persisted.accountEpoch) return false;
        activeConsent = { status: "accepted", versions: pending.input.acceptedPolicyVersions, acceptedAt: consent.acceptedAt };
        await adapter.setPreferences(pending.preferences, session.accessToken);
        if (pending.epoch !== persisted.accountEpoch) return false;
        persisted.consent = { ...pending.input.acceptedPolicyVersions, acceptedAt: consent.acceptedAt };
        persisted.preferences = pending.preferences; persisted.persistedPreferences = pending.preferences;
        persisted.privacyBarrier = pending.preferences.visibility !== "public";
        persisted.setupBarrier = !pending.preferences.setupUploads;
        persisted.preferencePersistence = "confirmed";
        activePreferences = pending.preferences; activePersistedPreferences = pending.preferences;
        connectedAccount = { status: "connected", account: profile };
        save();
        return true;
      } catch {
        activeAccessToken = null; activeUserId = null; accessExpiresAt = 0;
        activeConsent = { status: "not_accepted" };
        connectedAccount = { status: "error", error: error("auth_failed") };
        try { await clearRefreshToken(); } catch { /* Report failure without exposing store/provider details. */ }
        try { save(); } catch { /* state remains fail-closed */ }
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
      try {
        const acceptance = await adapter.acceptConsent(input.acceptedPolicyVersions, await accessToken() ?? "");
        persisted.consent = { ...input.acceptedPolicyVersions, acceptedAt: acceptance.acceptedAt };
        activeConsent = { status: "accepted", versions: input.acceptedPolicyVersions, acceptedAt: acceptance.acceptedAt };
        save();
        return { ok: true, state: snapshot() };
      } catch { return failure("auth_failed"); }
    },
    async setPreferences(input: PreferencesInput) {
      const wasStale = stale(input);
      if (input.accountEpoch !== persisted.accountEpoch) return failure("stale_state");
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
      try {
        await adapter.setPreferences(input.preferences, await accessToken() ?? "");
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
    async signOut(input: OnlineMutationContext) {
      if (input.accountEpoch !== persisted.accountEpoch) return failure("stale_state");
      for (const pending of attempts.values()) pending.attempt.cancel();
      attempts.clear();
      persisted.accountEpoch = randomUUID();
      persisted.revision++;
      persisted.preferences = null; persisted.persistedPreferences = null; persisted.consent = null;
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
      const key = JSON.stringify([input.gameId, input.trackId, input.carId]);
      try {
        const result = await adapter.getLeaderboard(input);
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
