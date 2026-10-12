import { api, createRaceIqClient } from "@speedhq/live-client";
import { prepareUploadPayload } from "./payload";
import type { VerifiedRecordingCodec, UploadGame } from "./payload";

type AcceptanceInput = api.AcceptanceInput;
type OwnLap = api.OwnLap;
type UploadPreferencesInput = api.UploadPreferencesInput;
type ProfilePatch = api.ProfilePatch;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export type OnlineFailureCode = "offline" | "service_unavailable" | "policy_unavailable" | "policy_changed" | "not_connected" | "auth_failed" | "rate_limited" | "invalid_response" | "unknown_track" | "unknown_car" | "unsupported_game" | "f1_sanitization_failed";
const STATUS_BY_CODE: Record<OnlineFailureCode, number> = {
  offline: 503, service_unavailable: 503, policy_unavailable: 503, policy_changed: 409,
  not_connected: 403, auth_failed: 401, rate_limited: 429, invalid_response: 500,
  unknown_track: 400, unknown_car: 400, unsupported_game: 400, f1_sanitization_failed: 400,
};
export class OnlineAdapterError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly code: OnlineFailureCode;
  readonly retryable: boolean;
  constructor(code: OnlineFailureCode, retryable: boolean, retryAfter: string | null = null) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.name = "OnlineAdapterError";
    this.status = STATUS_BY_CODE[code];
    this.retryAfter = retryAfter;
  }
}
export interface OnlineCredentials {
  accessToken: string;
  consentAccepted: boolean;
  discordAccountName?: string | null;
}
export interface CanonicalBoardKey { gameId: string; trackId: string; carId: string }
export interface LocalBoardKey { gameId: string; trackId: string; carId: string }
export type BoardIdentifierResolution =
  | { status: "mapped"; key: CanonicalBoardKey }
  | { status: "unknown_track" | "unknown_car" | "unsupported_game" };
export interface BoardIdentifierResolver {
  resolve(input: LocalBoardKey): BoardIdentifierResolution;
}
export interface LeaderboardRow {
  rank: number;
  lapId: string;
  driver: { userId: string; displayName: string; avatarUrl: string | null };
  lapTimeMs: number;
}
export interface LeaderboardSnapshot {
  status: "ready" | "empty";
  rows: LeaderboardRow[];
  fetchedAt: string;
  stale: false;
}
export interface SanitizedLapUpload {
  gameId: UploadGame;
  filename: string;
  recording: Uint8Array;
  setup?: Uint8Array;
  idempotencyKey?: string;
  consentAccepted: boolean;
  visibility: "public" | "private";
  setupUploads: boolean;
  codec: VerifiedRecordingCodec | null;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createRaceIqOnlineAdapter(options: {
  baseUrl: string;
  credentials: () => Promise<OnlineCredentials | null>;
  identifiers: BoardIdentifierResolver;
  fetch?: typeof globalThis.fetch;
}) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new TypeError("Online service URL must use HTTPS");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const client = createRaceIqClient({
    baseUrl: base.href.replace(/\/$/, ""),
    fetch: Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      { preconnect: fetcher.preconnect },
    ),
  });

function retryAfterTimestamp(value: string | null): string | null {
  if (!value) return null;
  const seconds = Number(value);
  const timestamp = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1_000 : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
  async function authHeaders(requireConsent = true) {
    const credentials = await options.credentials();
    if (!credentials?.accessToken || (requireConsent && !credentials.consentAccepted)) throw new OnlineAdapterError("not_connected", false);
    return { Authorization: `Bearer ${credentials.accessToken}` };
  }
  async function writeHeaders(requireConsent = true) {
    return { ...(await authHeaders(requireConsent)), Origin: base.origin };
  }

  async function request<T>(run: () => Promise<{ response: Response; data?: T; error?: unknown }>, allowNoData = false): Promise<T> {
    try {
      const result = await run();
      if (!result.response.ok || (result.data === undefined && !allowNoData)) {
        const status = result.response.status;
        const code: OnlineFailureCode = status === 401 ? "auth_failed" : status === 403 ? "not_connected" : status === 409 ? "policy_changed" : status === 429 ? "rate_limited" : status >= 500 ? "service_unavailable" : "invalid_response";
        throw new OnlineAdapterError(code, status === 429 || status >= 500, status === 429 ? retryAfterTimestamp(result.response.headers.get("retry-after")) : null);
      }
      return result.data as T;
    } catch (error) {
      if (error instanceof OnlineAdapterError) throw error;
      throw new OnlineAdapterError("offline", true);
    }
  }

  return {
    async getPolicy() {
      const policy = await request(() => api.getConsentPolicy({ client: client.apiClient }));
      const termsVersion = stringField(policy.termsVersion);
      const privacyVersion = stringField(policy.privacyVersion);
      const termsUrl = safeUrl(policy.termsUrl);
      const privacyUrl = safeUrl(policy.privacyUrl);
      if (!policy.available || !termsVersion || !privacyVersion || !termsUrl || !privacyUrl) {
        throw new OnlineAdapterError("policy_unavailable", false);
      }
      return { available: true as const, termsUrl, privacyUrl, termsVersion, privacyVersion };
    },
    async getMe() {
      const credentials = await options.credentials();
      if (!credentials?.accessToken) throw new OnlineAdapterError("not_connected", false);
      const headers = { Authorization: `Bearer ${credentials.accessToken}` };
      const profile = await request(() => api.getMe({ client: client.apiClient, headers }));
      const userId = stringField(profile.userId);
      const displayName = stringField(profile.displayName);
      if (!userId || !displayName) throw new OnlineAdapterError("invalid_response", false);
      return { userId, displayName, avatarUrl: safeUrl(profile.avatarUrl), discordUsername: stringField(credentials.discordAccountName) };
    },
    async setDisplayName(displayName: string) {
      const credentials = await options.credentials();
      if (!credentials?.accessToken || !credentials.consentAccepted) throw new OnlineAdapterError("not_connected", false);
      const headers = { Authorization: `Bearer ${credentials.accessToken}`, Origin: base.origin };
      const body: ProfilePatch = { displayName };
      const profile = await request(() => api.patchMe({ client: client.apiClient, headers, body }));
      const userId = stringField(profile.userId);
      const returnedName = stringField(profile.displayName);
      if (!userId || !returnedName) throw new OnlineAdapterError("invalid_response", false);
      return { userId, displayName: returnedName, avatarUrl: safeUrl(profile.avatarUrl), discordUsername: stringField(credentials.discordAccountName) };
    },
    async getConsent() {
      const headers = await authHeaders(false);
      return request(() => api.getMyConsent({ client: client.apiClient, headers }));
    },
    async acceptConsent(input: AcceptanceInput) {
      const headers = await writeHeaders(false);
      return request(() => api.acceptConsent({ client: client.apiClient, headers, body: input }));
    },
    async getPreferences() {
      const headers = await authHeaders();
      return request(() => api.getMyPreferences({ client: client.apiClient, headers }));
    },
    async setPreferences(input: UploadPreferencesInput) {
      const headers = await writeHeaders();
      return request(() => api.setMyPreferences({ client: client.apiClient, headers, body: input }));
    },
    async listOwnLaps(gameId: string, offset = 0): Promise<{ items: OwnLap[]; nextOffset: number | null }> {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new OnlineAdapterError("invalid_response", false);
      const headers = await authHeaders();
      const page = await request(() => api.listOwnLaps({ client: client.apiClient, headers, query: { gameId, limit: 50, offset } }));
      return { items: page.items, nextOffset: page.items.length === 50 ? offset + page.items.length : null };
    },
    async unpublishLap(lapId: string): Promise<void> {
      const headers = await writeHeaders();
      await request(() => api.unpublishLap({ client: client.apiClient, headers, path: { lapId } }), true);
    },
    async uploadLap(input: SanitizedLapUpload) {
      if (!input.consentAccepted || input.visibility !== "public") throw new OnlineAdapterError("not_connected", false);
      if (!(input.recording instanceof Uint8Array) || input.recording.byteLength === 0 || input.recording.byteLength > MAX_UPLOAD_BYTES) throw new OnlineAdapterError("invalid_response", false);
      const prepared = prepareUploadPayload({
        gameId: input.gameId,
        recording: input.recording,
        filename: input.filename,
        setupAttachment: input.setup ?? null,
        setupUploadsAllowed: input.setupUploads,
        codec: input.codec,
      });
      if (!prepared.ok) throw new OnlineAdapterError(prepared.reason === "f1_sanitization_failed" ? "f1_sanitization_failed" : "unsupported_game", false);
      if (prepared.recording.byteLength === 0 || prepared.recording.byteLength > MAX_UPLOAD_BYTES) throw new OnlineAdapterError("invalid_response", false);
      if (prepared.setup && (prepared.setup.byteLength === 0 || prepared.setup.byteLength > MAX_UPLOAD_BYTES)) throw new OnlineAdapterError("invalid_response", false);
      const headers = await writeHeaders();
      return request(() => api.submitLap({
        client: client.apiClient,
        headers: { ...headers, ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}) },
        query: { gameId: input.gameId },
        body: { recording: new Blob([prepared.recording], { type: "application/octet-stream" }), setup: prepared.setup ? new Blob([prepared.setup]) : undefined },
      }));
    },
    async getLeaderboard(input: LocalBoardKey): Promise<LeaderboardSnapshot> {
      const resolution = options.identifiers.resolve(input);
      if (resolution.status !== "mapped") throw new OnlineAdapterError(resolution.status, false);
      const page = await request(() => api.getPublicLeaderboard({ client: client.apiClient, query: { ...resolution.key, limit: 50, offset: 0 } }));
      if (!page || !Array.isArray(page.items)) throw new OnlineAdapterError("invalid_response", false);
      const rows = page.items.map((item) => {
        const driver = item?.driver;
        if (!driver || typeof driver !== "object") throw new OnlineAdapterError("invalid_response", false);
        const userId = stringField(driver.userId);
        const displayName = stringField(driver.displayName);
        const lapId = stringField(item.id);
        if (!userId || !displayName || !lapId || !Number.isSafeInteger(item.rank) || item.rank < 1 || !Number.isSafeInteger(item.totalTimeMs) || item.totalTimeMs < 0) throw new OnlineAdapterError("invalid_response", false);
        return { rank: item.rank, lapId, driver: { userId, displayName, avatarUrl: safeUrl(driver.avatarUrl) }, lapTimeMs: item.totalTimeMs };
      });
      return { status: rows.length ? "ready" : "empty", rows, fetchedAt: new Date().toISOString(), stale: false };
    },
  };
}
