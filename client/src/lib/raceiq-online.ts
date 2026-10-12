import type { CancelSignInInput, ConnectInput, ConnectResult, ConsentInput, DisplayNameInput, LeaderboardInput, OnlineCommandResult, OnlineConnection, OnlineConsent, OnlineError, OnlineErrorCode, OnlineLeaderboard, OnlineMutationContext, OnlinePolicy, OnlinePreferences, OnlinePublication, OnlineState, OnlineSync, OnlineSyncBlock, OnlineTransportError, PolicyVersions, PreferencesInput, RaceIqOnlinePort } from "@raceiq/shared/integrations/raceiq-online";
import { client } from "./rpc";
export type { RaceIqOnlinePort };

export class OnlineTransportFailure extends Error implements OnlineTransportError {
  readonly kind = "transport";
  readonly code: OnlineTransportError["code"];
  readonly retryable: boolean;
  constructor(code: OnlineTransportError["code"]) {
    super(code);
    this.name = "OnlineTransportFailure";
    this.code = code;
    this.retryable = code === "backend_unreachable";
  }
}
export function isCurrentOnlineGeneration(requestGeneration: number, currentGeneration: number): boolean {
  return requestGeneration === currentGeneration;
}
export function isOnlineStateRevisionCurrent(current: OnlineState | undefined, next: OnlineState): boolean {
  return current === undefined || current.accountEpoch !== next.accountEpoch || next.revision >= current.revision;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNullableString = (v: unknown): v is string | null => v === null || isString(v);
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v));
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every((key) => key in value);
const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try { const url = new URL(v); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
};
const isEnum = <T extends string>(v: unknown, values: readonly T[]): v is T => values.some((candidate) => candidate === v);
const errorCodes: readonly OnlineErrorCode[] = ["offline", "service_unavailable", "policy_unavailable", "policy_changed", "not_connected", "auth_failed", "auth_cancelled", "consent_required", "sharing_required", "stale_state", "invalid_request", "preferences_failed", "rate_limited", "unsupported_game", "unknown_track", "unknown_car", "ineligible_lap", "f1_sanitization_failed", "validation_rejected", "account_unavailable", "unpublish_failed", "external_open_failed", "internal_error"];
const blocks: readonly OnlineSyncBlock[] = ["signed_out", "consent_required", "private", "preferences_unconfirmed", "offline", "service_unavailable", "account_unavailable"];
function isError(v: unknown): v is OnlineError { return isRecord(v) && hasExactKeys(v, ["code", "retryable", "retryAfter"]) && isEnum(v.code, errorCodes) && typeof v.retryable === "boolean" && (v.retryAfter === null || isIso(v.retryAfter)); }
function isVersions(v: unknown): v is PolicyVersions { return isRecord(v) && hasExactKeys(v, ["termsVersion", "privacyVersion"]) && isString(v.termsVersion) && isString(v.privacyVersion); }
function isPreferences(v: unknown): v is OnlinePreferences { return isRecord(v) && hasExactKeys(v, ["visibility", "setupUploads"]) && isEnum(v.visibility, ["private", "public"] as const) && typeof v.setupUploads === "boolean"; }
function isConnection(v: unknown): v is OnlineConnection {
  if (!isRecord(v)) return false;
  if (v.status === "signed_out") return hasExactKeys(v, ["status"]);
  if (v.status === "signing_in") return hasExactKeys(v, ["status", "flowId"]) && isString(v.flowId);
  if (v.status === "error") return hasExactKeys(v, ["status", "error"]) && isError(v.error);
  return v.status === "connected" && hasExactKeys(v, ["status", "account"]) && isRecord(v.account) && (hasExactKeys(v.account, ["userId", "displayName", "avatarUrl"]) || hasExactKeys(v.account, ["userId", "displayName", "avatarUrl", "discordUsername"])) && isString(v.account.userId) && isString(v.account.displayName) && isNullableString(v.account.avatarUrl) && (!("discordUsername" in v.account) || v.account.discordUsername === null || isString(v.account.discordUsername));
}
function isPolicy(v: unknown): v is OnlinePolicy {
  if (!isRecord(v)) return false;
  if (v.status === "unavailable") return hasExactKeys(v, ["status", "error"]) && (v.error === null || isError(v.error));
  return v.status === "available" && hasExactKeys(v, ["status", "versions", "termsUrl", "privacyUrl"]) && isVersions(v.versions) && isHttpsUrl(v.termsUrl) && isHttpsUrl(v.privacyUrl);
}
function isConsent(v: unknown): v is OnlineConsent {
  if (!isRecord(v)) return false;
  if (v.status === "not_accepted") return hasExactKeys(v, ["status"]);
  if (v.status === "accepted") return hasExactKeys(v, ["status", "versions", "acceptedAt"]) && isVersions(v.versions) && isIso(v.acceptedAt);
  return v.status === "required" && hasExactKeys(v, ["status", "previousVersions"]) && (v.previousVersions === null || isVersions(v.previousVersions));
}
function isSync(v: unknown): v is OnlineSync {
  return isRecord(v) && hasExactKeys(v, ["status", "blockedBy", "queued", "inFlight", "rejected", "lastSyncedAt", "lastError"]) && isEnum(v.status, ["idle", "running", "paused", "blocked"] as const) && (v.blockedBy === null || isEnum(v.blockedBy, blocks)) && Number.isSafeInteger(v.queued) && Number(v.queued) >= 0 && Number.isSafeInteger(v.inFlight) && Number(v.inFlight) >= 0 && Number.isSafeInteger(v.rejected) && Number(v.rejected) >= 0 && (v.lastSyncedAt === null || isIso(v.lastSyncedAt)) && (v.lastError === null || isError(v.lastError)) && ((v.status === "idle" || v.status === "running") ? v.blockedBy === null : v.blockedBy !== null);
}
function isPublication(v: unknown): v is OnlinePublication { return isRecord(v) && hasExactKeys(v, ["status", "error"]) && isEnum(v.status, ["none", "pending", "complete", "failed", "unavailable"] as const) && (v.error === null || isError(v.error)); }
export function isOnlineState(v: unknown): v is OnlineState {
  return isRecord(v) && hasExactKeys(v, ["contractVersion", "revision", "accountEpoch", "service", "connection", "policy", "consent", "preferences", "persistedPreferences", "preferencePersistence", "uploadAllowed", "sync", "publicationWithdrawal"]) && v.contractVersion === 1 && Number.isSafeInteger(v.revision) && Number(v.revision) >= 0 && isString(v.accountEpoch) && isEnum(v.service, ["available", "offline", "unavailable"] as const) && isConnection(v.connection) && isPolicy(v.policy) && isConsent(v.consent) && (v.preferences === null || isPreferences(v.preferences)) && (v.persistedPreferences === null || isPreferences(v.persistedPreferences)) && isEnum(v.preferencePersistence, ["unconfirmed", "confirmed", "pending", "failed"] as const) && typeof v.uploadAllowed === "boolean" && isSync(v.sync) && isPublication(v.publicationWithdrawal);
}
function isCommand(v: unknown): v is OnlineCommandResult { return isRecord(v) && typeof v.ok === "boolean" && hasExactKeys(v, v.ok ? ["ok", "state"] : ["ok", "error", "state"]) && isOnlineState(v.state) && (v.ok ? !("error" in v) : isError(v.error)); }
function isConnect(v: unknown): v is ConnectResult { return isRecord(v) && typeof v.ok === "boolean" && hasExactKeys(v, v.ok ? ["ok", "state", "authorizationUrl", "flowId"] : ["ok", "state", "error"]) && isOnlineState(v.state) && (v.ok ? isString(v.authorizationUrl) && isString(v.flowId) : isError(v.error)); }
export function isOnlineLeaderboard(v: unknown): v is OnlineLeaderboard {
  return isRecord(v) && hasExactKeys(v, ["key", "status", "rows", "fetchedAt", "stale", "error"]) && isRecord(v.key) && hasExactKeys(v.key, ["gameId", "trackId", "carId"]) && isString(v.key.gameId) && isString(v.key.trackId) && isString(v.key.carId) && isEnum(v.status, ["ready", "empty", "unavailable"] as const) && Array.isArray(v.rows) && v.rows.every((row: unknown) => isRecord(row) && hasExactKeys(row, ["rank", "lapId", "driver", "lapTimeMs"]) && Number.isSafeInteger(row.rank) && Number(row.rank) > 0 && isString(row.lapId) && isRecord(row.driver) && hasExactKeys(row.driver, ["userId", "displayName", "avatarUrl"]) && isString(row.driver.userId) && isString(row.driver.displayName) && isNullableString(row.driver.avatarUrl) && Number.isSafeInteger(row.lapTimeMs) && Number(row.lapTimeMs) > 0) && (v.fetchedAt === null || isIso(v.fetchedAt)) && typeof v.stale === "boolean" && (v.error === null || isError(v.error)) && (v.status === "ready" ? v.rows.length > 0 : v.status === "empty" ? v.rows.length === 0 : true);
}
export async function receiveOnlineResponse<T>(response: Response, validate: (value: unknown) => value is T, expected: readonly number[]): Promise<T> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new OnlineTransportFailure("invalid_response"); }
  if (!expected.includes(response.status) || !validate(value)) throw new OnlineTransportFailure("invalid_response");
  if (isRecord(value) && "ok" in value) {
    if ((response.status >= 400 && value.ok !== false) || (response.status < 400 && value.ok === false)) throw new OnlineTransportFailure("invalid_response");
  }
  return value;
}
async function call<T>(request: Promise<Response>, validate: (value: unknown) => value is T, expected: readonly number[]): Promise<T> {
  let response: Response;
  try { response = await request; } catch { throw new OnlineTransportFailure("backend_unreachable"); }
  return receiveOnlineResponse(response, validate, expected);
}
const commandStatuses = [200, 400, 401, 403, 409, 429, 500, 503] as const;
const commandFailureStatuses = [400, 401, 403, 409, 429, 500, 503] as const;
export const raceIqOnlinePort: RaceIqOnlinePort = {
  getState: () => call(client.api.online.state.$get(), isOnlineState, [200]),
  connect: (input: ConnectInput) => call(client.api.online.connect.$post({ json: input }), isConnect, [202, ...commandFailureStatuses]),
  cancelSignIn: (input: CancelSignInInput) => call(client.api.online.connect.cancel.$post({ json: input }), isCommand, commandStatuses),
  acceptConsent: (input: ConsentInput) => call(client.api.online.consent.$put({ json: input }), isCommand, commandStatuses),
  setPreferences: (input: PreferencesInput) => call(client.api.online.preferences.$put({ json: input }), isCommand, commandStatuses),
  signOut: (input: OnlineMutationContext) => call(client.api.online["sign-out"].$post({ json: input }), isCommand, commandStatuses),
  setDisplayName: (input: DisplayNameInput) => call(client.api.online.profile.$put({ json: input }), isCommand, commandStatuses),
  getLeaderboard: (input: LeaderboardInput) => call(client.api.online.leaderboard.$get({ query: { trackId: input.trackId, carId: input.carId } }, { headers: { "X-Game-Id": input.gameId } }), isOnlineLeaderboard, [200]),
};
