import { api, createRaceIqClient } from "@speedhq/live-client";
import { prepareUploadPayload,uploadPayloadFingerprint,MAX_ONLINE_UPLOAD_BYTES,MAX_ONLINE_SETUP_BYTES } from "./payload";
import type { VerifiedRecordingCodec, UploadGame, OnlineLapIdentity } from "./payload";
import type { GameIdentityBinding } from "../contracts/index";

type AcceptanceInput = api.AcceptanceInput;
type OwnLap = api.OwnLap;
type UploadPreferencesInput = api.UploadPreferencesInput;
type ProfilePatch = api.ProfilePatch;
const REQUEST_TIMEOUT_MS = 8_000;
const UPLOAD_TRANSFER_TIMEOUT_MS=600_000;

export type OnlineFailureCode = "offline" | "service_unavailable" | "policy_unavailable" | "policy_changed" | "not_connected" | "auth_failed" | "rate_limited" | "invalid_response" | "unknown_track" | "unknown_car" | "unsupported_game" | "unsupported_recording_format" | "recording_too_large" | "f1_sanitization_failed" | "activity_identity_ambiguous" | "activity_owner_conflict" | "activity_revision_conflict" | "lap_owner_conflict" | "lap_identity_conflict";
const STATUS_BY_CODE: Record<OnlineFailureCode, number> = {
  offline: 503, service_unavailable: 503, policy_unavailable: 503, policy_changed: 409,
  not_connected: 403, auth_failed: 401, rate_limited: 429, invalid_response: 500,
  unsupported_recording_format:400,recording_too_large:413,
  unknown_track: 400, unknown_car: 400, unsupported_game: 400, f1_sanitization_failed: 400,
  activity_identity_ambiguous: 409,activity_owner_conflict: 409,activity_revision_conflict: 409,lap_owner_conflict: 409,lap_identity_conflict: 409,
};
export class OnlineAdapterError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly code: OnlineFailureCode;
  readonly retryable: boolean;
  readonly responseStatus: number | null;
  constructor(code: OnlineFailureCode, retryable: boolean, retryAfter: string | null = null, responseStatus: number | null = null) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.name = "OnlineAdapterError";
    this.status = STATUS_BY_CODE[code];
    this.retryAfter = retryAfter;
    this.responseStatus = responseStatus;
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
  lapGuid: string;
  driver: { userId: string; displayName: string; avatarUrl: string | null };
  lapTimeMs: number;
  importAvailable: boolean;
}
export interface LeaderboardSnapshot {
  status: "ready" | "empty";
  rows: LeaderboardRow[];
  fetchedAt: string;
  stale: false;
}
export interface ReserveLapUploadInput extends OnlineLapIdentity {
  gameId: UploadGame;
  idempotencyKey: string;
  consentAccepted: boolean;
  visibility: "private" | "public";
  isAuthorized: () => boolean;
  isCurrent?: () => Promise<boolean>;
}
export interface ReserveLapUploadResult { reservationToken: string | null; acceptedJobId: string | null }
export interface SanitizedLapUpload extends OnlineLapIdentity {
  gameId: UploadGame;
  carId: string;
  filename: string;
  recording: Uint8Array;
  setup?: Uint8Array;
  idempotencyKey: string;
  reservationToken: string;
  payloadFingerprint: string;
  consentAccepted: boolean;
  visibility: "private" | "public";
  setupUploads: boolean;
  codec: VerifiedRecordingCodec | null;
  isAuthorized: () => boolean;
  isSourceCurrent(): Promise<boolean>;
}

function acceptedJobId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value) || !("jobId" in value)) return null;
  const accepted = value.error;
  return accepted && typeof accepted === "object" && "code" in accepted &&
    accepted.code === "UPLOAD_ALREADY_ACCEPTED" && typeof value.jobId === "string"
    ? value.jobId
    : null;
}

function isReservationExpired(value: unknown): boolean {
  return !!value && typeof value === "object" && "error" in value && !!value.error &&
    typeof value.error === "object" && "code" in value.error && value.error.code === "UPLOAD_RESERVATION_EXPIRED";
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
  function uploadFetch(isAuthorized:()=>boolean,timeoutMs=REQUEST_TIMEOUT_MS,beforeSend?:()=>Promise<boolean>) {
    return async (request: Request): Promise<Response> => {
      await Bun.sleep(0);
      const credentials=await options.credentials();
      if(!credentials?.accessToken||!credentials.consentAccepted||request.headers.get("Authorization")!==`Bearer ${credentials.accessToken}`)throw new OnlineAdapterError("not_connected",false);
      if(beforeSend){
        let current:boolean;
        try{current=await beforeSend();}catch{throw new OnlineAdapterError("service_unavailable",true);}
        if(!current)throw new OnlineAdapterError("activity_revision_conflict",false);
      }
      if (!isAuthorized()) throw new OnlineAdapterError("not_connected", false);
      return fetcher(request,{redirect:"error",signal:AbortSignal.timeout(timeoutMs)});
    };
  }

  async function request<T>(run: () => Promise<{ response: Response; data?: T; error?: unknown }>, allowNoData = false): Promise<T> {
    try {
      const result = await run();
      if (!result.response.ok || (result.data === undefined && !allowNoData)) {
        const status = result.response.status;
        const remote = result.error && typeof result.error === "object" && "error" in result.error ? result.error.error : null;
        const remoteCode = remote && typeof remote === "object" && "code" in remote ? remote.code : null;
        const conflict = remoteCode === "LAP_OWNER_CONFLICT" ? "lap_owner_conflict" : remoteCode === "LAP_IDENTITY_CONFLICT" ? "lap_identity_conflict"
          : remoteCode === "ACTIVITY_OWNER_CONFLICT" ? "activity_owner_conflict" : remoteCode === "ACTIVITY_REVISION_CONFLICT" ? "activity_revision_conflict"
          : remoteCode === "ACTIVITY_IDENTITY_AMBIGUOUS" ? "activity_identity_ambiguous" : null;
        if (conflict) throw new OnlineAdapterError(conflict,false,null,status);
        const code: OnlineFailureCode = status === 401 ? "auth_failed" : status === 403 ? "not_connected" : status === 409 ? "policy_changed" : status === 429 ? "rate_limited" : status >= 500 ? "service_unavailable" : "invalid_response";
        throw new OnlineAdapterError(code, status === 429 || status >= 500, status === 429 ? retryAfterTimestamp(result.response.headers.get("retry-after")) : null, status);
      }
      return result.data as T;
    } catch (error) {
      if (error instanceof OnlineAdapterError) throw error;
      throw new OnlineAdapterError("offline", true);
    }
  }

  return {
    async registerGameBinding(binding:GameIdentityBinding,confirmedByUser:true,isAuthorized:()=>boolean) {
      if(confirmedByUser!==true)throw new OnlineAdapterError("not_connected",false);
      const headers=await writeHeaders();
      const bindings=await request(()=>api.listMyGameBindings({client:client.apiClient,headers,fetch:uploadFetch(isAuthorized)}));
      const current=bindings.find(candidate=>candidate.gameId===binding.gameId);
      if(current&&current.confirmation==="user_confirmed"&&current.sourceKind===binding.sourceKind&&current.nativeIdentity===binding.nativeIdentity)return {id:current.id,revision:current.revision};
      const registered=await request(()=>api.putMyGameBinding({client:client.apiClient,headers,fetch:uploadFetch(isAuthorized),path:{game_id:binding.gameId},
        body:{sourceKind:binding.sourceKind,nativeIdentity:binding.nativeIdentity,confirmation:"user_confirmed",expectedRevision:current?.revision??null}}));
      if(registered.gameId!==binding.gameId||registered.sourceKind!==binding.sourceKind||registered.nativeIdentity!==binding.nativeIdentity||registered.confirmation!=="user_confirmed")throw new OnlineAdapterError("invalid_response",false);
      return {id:registered.id,revision:registered.revision};
    },
    async getLapJob(jobId: string, isAuthorized: () => boolean) {
      const headers = await authHeaders();
      return request(() => api.getLapJob({ client: client.apiClient, headers, fetch: uploadFetch(isAuthorized), path: { jobId } }));
    },
    async readOwnerStats(isAuthorized:()=>boolean) {
      const headers=await authHeaders();
      const result=await api.getMyStats({client:client.apiClient,headers,fetch:uploadFetch(isAuthorized)});
      if(result.response.status===404) return null;
      return request(()=>Promise.resolve(result));
    },
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
    async getMe(accessToken?:string,discordAccountName?:string|null) {
      // Bootstrap verification must not re-enter the refresh promise that is waiting for this read.
      const credentials=accessToken===undefined?await options.credentials():null;
      const token=accessToken??credentials?.accessToken;
      if (!token) throw new OnlineAdapterError("not_connected", false);
      const headers = { Authorization: `Bearer ${token}` };
      const profile = await request(() => api.getMe({ client: client.apiClient, headers }));
      const userId = stringField(profile.userId);
      const displayName = stringField(profile.displayName);
      if (!userId || !displayName) throw new OnlineAdapterError("invalid_response", false);
      return { userId, displayName, avatarUrl: safeUrl(profile.avatarUrl), discordUsername: stringField(discordAccountName??credentials?.discordAccountName) };
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
      const page = await request(() => api.listOwnLaps({ client: client.apiClient, headers, query: { gameId, limit: 10, offset } }));
      return { items: page.items, nextOffset: page.items.length === 10 ? offset + page.items.length : null };
    },
    async unpublishLap(lapId: string): Promise<void> {
      const headers = await writeHeaders();
      await request(() => api.unpublishLap({ client: client.apiClient, headers, path: { lapId } }), true);
    },
    async reserveLapUpload(input: ReserveLapUploadInput): Promise<ReserveLapUploadResult> {
      if (!input.consentAccepted || input.visibility !== "public") throw new OnlineAdapterError("not_connected", false);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.idempotencyKey)) {
        throw new OnlineAdapterError("invalid_response", false);
      }
      const headers = await writeHeaders();
      const result = await api.reserveLapUpload({
        client: client.apiClient,
        fetch: uploadFetch(input.isAuthorized, REQUEST_TIMEOUT_MS, input.isCurrent),
        headers: { ...headers, "Idempotency-Key": input.idempotencyKey },
        body: { gameId:input.gameId,lapGuid:input.lapGuid,driverBindingId:input.driverBindingId,driverBindingRevision:input.driverBindingRevision,
          originalActivityId:input.originalActivityId,sourceRevision:input.sourceRevision,sourceKind:input.sourceKind },
      });
      const accepted = acceptedJobId(result.error);
      if (result.response.status === 409 && accepted) return { reservationToken: null, acceptedJobId: accepted };
      if (result.response.status === 423) throw new OnlineAdapterError("rate_limited", true, retryAfterTimestamp(result.response.headers.get("retry-after")), 423);
      const reservation = await request(() => Promise.resolve(result));
      if (typeof reservation.reservationToken !== "string" || reservation.reservationToken.length === 0) {
        throw new OnlineAdapterError("invalid_response", false);
      }
      return { reservationToken: reservation.reservationToken, acceptedJobId: null };
    },
    async uploadLap(input: SanitizedLapUpload): Promise<{ id: string } | { acceptedJobId: string }> {
      if (!input.consentAccepted || input.visibility !== "public") throw new OnlineAdapterError("not_connected", false);
      if(input.gameId==="f1-2025"&&input.carId!=="41")throw new OnlineAdapterError("unsupported_game",false);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.idempotencyKey) ||
          !input.reservationToken) throw new OnlineAdapterError("invalid_response", false);
      if (!(input.recording instanceof Uint8Array) || input.recording.byteLength === 0 || input.recording.byteLength > MAX_ONLINE_UPLOAD_BYTES) throw new OnlineAdapterError("invalid_response", false);
      const prepared = await prepareUploadPayload({
        gameId: input.gameId,
        recording: input.recording,
        filename: input.filename,
        setupAttachment: input.setup ?? null,
        setupUploadsAllowed: input.setupUploads,
        codec: input.codec,
      });
      if(!prepared.ok)throw new OnlineAdapterError(prepared.reason,false);
      if(prepared.recording.byteLength===0)throw new OnlineAdapterError("unsupported_recording_format",false);
      if(prepared.recording.byteLength>MAX_ONLINE_UPLOAD_BYTES)throw new OnlineAdapterError("recording_too_large",false);
      if(prepared.setup&&(prepared.setup.byteLength===0||prepared.setup.byteLength>MAX_ONLINE_SETUP_BYTES))throw new OnlineAdapterError("invalid_response",false);
      if(await uploadPayloadFingerprint(prepared.recording,prepared.setup)!==input.payloadFingerprint)throw new OnlineAdapterError("lap_identity_conflict",false);
      const headers = await writeHeaders();
      const result = await api.submitLap({
        client: client.apiClient,
        fetch:uploadFetch(input.isAuthorized,UPLOAD_TRANSFER_TIMEOUT_MS,input.isSourceCurrent),
        headers: { ...headers, "Idempotency-Key": input.idempotencyKey, "Upload-Reservation-Token": input.reservationToken },
        query: { gameId:input.gameId,lapGuid:input.lapGuid,driverBindingId:input.driverBindingId,driverBindingRevision:input.driverBindingRevision,
          originalActivityId:input.originalActivityId,sourceRevision:input.sourceRevision,sourceKind:input.sourceKind },
        body: { recording: new Blob([prepared.recording], { type: "application/octet-stream" }), setup: prepared.setup ? new Blob([prepared.setup]) : undefined },
      });
      const accepted = result.response.status === 409 ? acceptedJobId(result.error) : null;
      if (accepted) return { acceptedJobId: accepted };
      if (result.response.status === 423) throw new OnlineAdapterError("rate_limited", true, retryAfterTimestamp(result.response.headers.get("retry-after")), 423);
      if (result.response.status === 409 && isReservationExpired(result.error)) throw new OnlineAdapterError("service_unavailable", true, null, 409);
      return request(() => Promise.resolve(result));
    },
    async getLeaderboard(input: LocalBoardKey,isAuthorized:()=>boolean): Promise<LeaderboardSnapshot> {
      const resolution = options.identifiers.resolve(input);
      if (resolution.status !== "mapped") throw new OnlineAdapterError(resolution.status, false);
      if(resolution.key.gameId==="f1-2025"&&resolution.key.carId!=="41")throw new OnlineAdapterError("unsupported_game",false);
      const headers = await authHeaders();
      const page = await request(() => api.getLeaderboard({ client: client.apiClient, headers,fetch:uploadFetch(isAuthorized),query: { ...resolution.key, limit: 50, offset: 0 } }));
      if (!page || !Array.isArray(page.items)) throw new OnlineAdapterError("invalid_response", false);
      const rows = page.items.map((item) => {
        const driver = item?.driver;
        if (!driver || typeof driver !== "object") throw new OnlineAdapterError("invalid_response", false);
        const userId = stringField(driver.userId);
        const displayName = stringField(driver.displayName);
        const lapId = stringField(item.id);
        const lapGuid = stringField("lapGuid" in item ? item.lapGuid : null);
        if (!userId || !displayName || !lapId || !lapGuid || !Number.isSafeInteger(item.rank) || item.rank < 1 || !Number.isSafeInteger(item.totalTimeMs) || item.totalTimeMs < 0) throw new OnlineAdapterError("invalid_response", false);
        return { rank: item.rank, lapId, lapGuid, driver: { userId, displayName, avatarUrl: safeUrl(driver.avatarUrl) }, lapTimeMs: item.totalTimeMs, importAvailable: item.importAvailable === true };
      });
      return { status: rows.length ? "ready" : "empty", rows, fetchedAt: new Date().toISOString(), stale: false };
    },
  };
}
