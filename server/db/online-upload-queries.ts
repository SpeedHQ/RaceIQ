import type { OnlineErrorCode, UploadItem } from "@raceiq/online/contracts";
import { sql } from "drizzle-orm";
import { db, readDb } from "./index";
import { withDatabaseWrite } from "./write-coordination";
import { getLocalAccountOwner } from "./local-account-queries";
import { getRecordingInstallationId } from "./recording-origin";
import { isWholeLapSelf, type DriverAttributionStint } from "@raceiq/shared/driver-attribution";

export interface OnlineUploadWinner {
  lapId: number;
  gameId: string;
  trackId: string;
  carId: string;
  lapTimeMs: number;
}
export interface OnlineLapUpload extends OnlineUploadWinner {
  accountId: string;
  originalActivityId: string;
  lapGuid: string;
  result: string | null;
  idempotencyKey: string | null;
  identityJson: string | null;
  payloadFingerprint: string | null;
  reservationToken: string | null;
  remoteJobId: string | null;
  uploadedAt: string | null;
  retryAfter: string | null;
}
export interface OnlineUploadWinnerPage { items: OnlineUploadWinner[]; nextCursor: number | null }
export interface RetainedOnlineLapRequest {
  accountId: string;
  idempotencyKey: string;
  identityJson: string;
  payloadFingerprint: string;
  reservationToken?: string | null;
}

interface UploadRow extends OnlineUploadWinner {
  accountId: string;
  originalActivityId: string;
  lapGuid: string;
  result: string | null;
  idempotencyKey: string | null;
  identityJson: string | null;
  payloadFingerprint: string | null;
  reservationToken: string | null;
  remoteJobId: string | null;
  uploadedAt: string | null;
  retryAfter: string | null;
  stintsJson: string;
  sourceClockDomain: string;
  sourceLapStartMs: number;
  sourceLapEndMs: number;
  sourceValid: number;
  installationId: string;
}

const knownUploadErrorCodes: OnlineErrorCode[] = ["offline","service_unavailable","policy_unavailable","policy_changed","not_connected","auth_failed","auth_cancelled","consent_required","stale_state","invalid_request","preferences_failed","sharing_required","rate_limited","unsupported_game","unknown_track","unknown_car","ineligible_lap","capture_active","driver_identity_required","mixed_driver_lap","activity_identity_ambiguous","activity_revision_conflict","activity_owner_conflict","lap_owner_conflict","lap_identity_conflict","f1_sanitization_failed","validation_rejected","account_unavailable","unsupported_recording_format","recording_too_large","recording_not_ready","unpublish_failed","external_open_failed","internal_error"];

/** Read stable, account-scoped lap queue/history rows for the public upload page. */
export async function readLapUploadItems(accountId: string, view: "queue" | "history", boundary: { time: number; id: string } | null, limit: number): Promise<UploadItem[]> {
  if (!accountId || await getLocalAccountOwner() !== accountId || !Number.isSafeInteger(limit) || limit < 1) return [];
  const boundedLimit = Math.min(limit, 101);

  const installationId = getRecordingInstallationId();
  const items: UploadItem[] = [];
  let scannedBoundary = boundary;
  while (items.length < boundedLimit) {
    const rows = await readDb.all<UploadRow & { admittedAt: string; resultAt: string | null }>(sql`SELECT ${selectWinnerFields},s.owner_user_id AS accountId,s.original_activity_id AS originalActivityId,l.lap_guid AS lapGuid,
      l.online_upload_result AS result,l.online_idempotency_key AS idempotencyKey,l.online_identity_json AS identityJson,
      l.online_payload_fingerprint AS payloadFingerprint,l.online_reservation_token AS reservationToken,l.online_remote_job_id AS remoteJobId,
      l.online_uploaded_at AS uploadedAt,l.online_retry_after AS retryAfter,l.driver_attribution_stints AS stintsJson,
      l.source_clock_domain AS sourceClockDomain,l.source_lap_start_ms AS sourceLapStartMs,l.source_lap_end_ms AS sourceLapEndMs,
      l.is_valid AS sourceValid,s.recording_installation_id AS installationId,l.online_evaluated_at AS admittedAt,l.online_result_at AS resultAt
      FROM laps l JOIN sessions s ON s.id=l.session_id
      WHERE ${view === "queue" ? sql`EXISTS(SELECT 1 FROM online_fastest_combo_laps w WHERE w.lap_id=l.id) AND ${eligibleWhere} AND s.owner_user_id=${accountId} AND l.online_upload_result IS NULL` : sql`l.online_account_id=${accountId} AND l.online_upload_result IS NOT NULL`}
        ${scannedBoundary ? view === "queue" ? sql`AND (l.online_evaluated_at>${new Date(scannedBoundary.time).toISOString()} OR (l.online_evaluated_at=${new Date(scannedBoundary.time).toISOString()} AND ('lap:'||l.id)>${scannedBoundary.id}))` : sql`AND (COALESCE(l.online_result_at,l.online_evaluated_at)<${new Date(scannedBoundary.time).toISOString()} OR (COALESCE(l.online_result_at,l.online_evaluated_at)=${new Date(scannedBoundary.time).toISOString()} AND ('lap:'||l.id)<${scannedBoundary.id}))` : sql``}
      ORDER BY ${view === "queue" ? sql`l.online_evaluated_at ASC,('lap:'||l.id) ASC` : sql`COALESCE(l.online_result_at,l.online_evaluated_at) DESC,('lap:'||l.id) DESC`} LIMIT ${boundedLimit}`);
    if (rows.length === 0) break;
    for (const row of rows) {
      scannedBoundary = { time: Date.parse(view === "queue" ? row.admittedAt : row.resultAt ?? row.admittedAt), id: `lap:${row.lapId}` };
      if (view !== "history" && (!eligible(row, installationId) || !Number.isSafeInteger(row.lapId) || !Number.isSafeInteger(row.lapTimeMs) || row.lapTimeMs <= 0)) continue;
      const terminal = row.result !== null;
      const timestamp = row.resultAt ?? row.admittedAt;
      items.push({ id: `lap:${row.lapId}`, kind: "lap", gameId: row.gameId || null, lapId: row.lapId, lapGuid: row.lapGuid || null,
        trackId: row.trackId || null, carId: row.carId || null, delivery: terminal ? row.result === "success" ? "accepted" : "rejected" : "awaiting",
        admittedAt: row.admittedAt, updatedAt: timestamp, settledAt: terminal ? timestamp : null, attemptCount: null,
        nextAttemptAt: row.retryAfter, acceptedAt: row.uploadedAt, remoteJobId: row.remoteJobId,
        validation: row.result === "success" ? "unavailable" : "not_requested", publication: row.result === "success" ? "unavailable" : "not_requested",
        error: row.result && row.result !== "success" ? { code: uploadErrorCode(row.result), retryable: false, retryAfter: null } : null });
      if (items.length === boundedLimit) break;
    }
    if (rows.length < boundedLimit) break;
  }
  return items;
}

const MAX_PAGE_SIZE = 250;
const supportedGameSql = sql` s.game_id IN ('acc','ac-evo','iracing','lmu','f1-2025') AND (s.game_id<>'f1-2025' OR s.car_id='41') `;
function decodeStints(json: string): DriverAttributionStint[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object")
      ? value as DriverAttributionStint[] : null;
  } catch { return null; }
}
function eligible(row: UploadRow, installationId: string): boolean {
  const stints = decodeStints(row.stintsJson);
  return row.sourceValid === 1 && row.installationId === installationId && row.gameId !== "" && row.trackId !== "" && row.trackId !== "-1" && row.carId !== "" && row.carId !== "-1" &&
    stints !== null && isWholeLapSelf(stints, row.sourceLapStartMs, row.sourceLapEndMs, row.sourceClockDomain);
}

function uploadErrorCode(value: string): OnlineErrorCode {
  return knownUploadErrorCodes.includes(value as OnlineErrorCode) ? value as OnlineErrorCode : "validation_rejected";
}
const selectWinnerFields = sql`l.id AS lapId,s.game_id AS gameId,s.track_id AS trackId,s.car_id AS carId,
  CAST(ROUND(CASE WHEN l.total_time_ms>0 THEN l.total_time_ms ELSE l.lap_time*1000 END) AS INTEGER) AS lapTimeMs`;
const eligibleJoins = sql`FROM online_fastest_combo_laps w JOIN laps l ON l.id=w.lap_id JOIN sessions s ON s.id=l.session_id`;
const eligibleWhere = sql`l.is_valid=1 AND l.lap_time>0 AND l.driver_attribution='Self' AND l.lap_guid IS NOT NULL AND l.driver_attribution_stints IS NOT NULL
  AND l.source_clock_domain IS NOT NULL AND l.source_lap_start_ms IS NOT NULL AND l.source_lap_end_ms IS NOT NULL
  AND l.online_upload_blocked_reason IS NULL
  AND s.recording_origin='native_capture' AND s.recording_installation_id=${getRecordingInstallationId()}
  AND s.ownership='mine' AND s.owner_user_id IS NOT NULL AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
  AND ${supportedGameSql}`;

/** Current eligible winners, ordered by selected lap ID; cursor is independent of initialization. */
export async function getOnlineUploadWinnerPage(afterLapId: number | null, limit: number): Promise<OnlineUploadWinnerPage> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Upload winner page limit must be a positive integer");
  const ownerId = await getLocalAccountOwner();
  if (!ownerId) return { items: [], nextCursor: null };
  const boundedLimit = Math.min(limit, MAX_PAGE_SIZE);
  const rows = await readDb.all<UploadRow>(sql`SELECT ${selectWinnerFields},s.owner_user_id AS accountId,s.original_activity_id AS originalActivityId,l.lap_guid AS lapGuid,
    l.online_upload_result AS result,l.online_idempotency_key AS idempotencyKey,l.online_identity_json AS identityJson,
    l.online_payload_fingerprint AS payloadFingerprint,l.online_reservation_token AS reservationToken,l.online_remote_job_id AS remoteJobId,
    l.online_uploaded_at AS uploadedAt,l.online_retry_after AS retryAfter,l.driver_attribution_stints AS stintsJson,
    l.source_clock_domain AS sourceClockDomain,l.source_lap_start_ms AS sourceLapStartMs,l.source_lap_end_ms AS sourceLapEndMs,
    l.is_valid AS sourceValid,s.recording_installation_id AS installationId
    ${eligibleJoins} WHERE ${eligibleWhere} AND s.owner_user_id=${ownerId} AND l.online_upload_result IS NULL AND l.id>${afterLapId ?? 0}
    ORDER BY l.id LIMIT ${boundedLimit + 1}`);
  const hasMore = rows.length > boundedLimit;
  const scanned = rows.slice(0, boundedLimit);
  const installationId = getRecordingInstallationId();
  const items = scanned.filter((row) => eligible(row, installationId) && Number.isSafeInteger(row.lapId) && Number.isSafeInteger(row.lapTimeMs) && row.lapTimeMs > 0)
    .map(({ lapId, gameId, trackId, carId, lapTimeMs }) => ({ lapId, gameId, trackId, carId, lapTimeMs }));
  return { items, nextCursor: hasMore ? scanned.at(-1)?.lapId ?? null : null };
}

/** Recheck origin, attribution, validity and current winner immediately before transport. */
export async function readOnlineLapUpload(lapId: number): Promise<OnlineLapUpload | null> {
  if (!Number.isSafeInteger(lapId) || lapId < 1) return null;
  const ownerId = await getLocalAccountOwner();
  if (!ownerId) return null;
  const rows = await readDb.all<UploadRow>(sql`SELECT ${selectWinnerFields},s.owner_user_id AS accountId,s.original_activity_id AS originalActivityId,l.lap_guid AS lapGuid,
    l.online_upload_result AS result,l.online_idempotency_key AS idempotencyKey,l.online_identity_json AS identityJson,
    l.online_payload_fingerprint AS payloadFingerprint,l.online_reservation_token AS reservationToken,l.online_remote_job_id AS remoteJobId,
    l.online_uploaded_at AS uploadedAt,l.online_retry_after AS retryAfter,l.driver_attribution_stints AS stintsJson,
    l.source_clock_domain AS sourceClockDomain,l.source_lap_start_ms AS sourceLapStartMs,l.source_lap_end_ms AS sourceLapEndMs,
    l.is_valid AS sourceValid,s.recording_installation_id AS installationId
    ${eligibleJoins} WHERE ${eligibleWhere} AND l.id=${lapId} AND s.owner_user_id=${ownerId} LIMIT 1`);
  const row = rows[0];
  if (!row || !eligible(row, getRecordingInstallationId()) || !row.originalActivityId || !row.lapGuid || !Number.isSafeInteger(row.lapTimeMs) || row.lapTimeMs <= 0) return null;
  return { lapId: row.lapId, gameId: row.gameId, trackId: row.trackId, carId: row.carId, lapTimeMs: row.lapTimeMs,
    accountId: row.accountId, originalActivityId: row.originalActivityId, lapGuid: row.lapGuid, result: row.result,
    idempotencyKey: row.idempotencyKey, identityJson: row.identityJson, payloadFingerprint: row.payloadFingerprint,
    reservationToken: row.reservationToken, remoteJobId: row.remoteJobId, uploadedAt: row.uploadedAt, retryAfter: row.retryAfter };
}

/** Retain immutable request bytes once, only for the still-current eligible winner. */
export async function retainOnlineLapRequest(lapId: number, request: RetainedOnlineLapRequest): Promise<boolean> {
  if (!Number.isSafeInteger(lapId) || lapId < 1 || !request.accountId || !request.idempotencyKey || !request.identityJson || !request.payloadFingerprint) return false;
  if (await getLocalAccountOwner() !== request.accountId || !await readOnlineLapUpload(lapId)) return false;
  const existing = await readDb.all<{ accountId: string | null; idempotencyKey: string | null; identityJson: string | null; payloadFingerprint: string | null; reservationToken: string | null }>(sql`SELECT online_account_id AS accountId,online_idempotency_key AS idempotencyKey,
    online_identity_json AS identityJson,online_payload_fingerprint AS payloadFingerprint,online_reservation_token AS reservationToken FROM laps WHERE id=${lapId}`);
  const old = existing[0];
  if (old?.idempotencyKey !== null && old?.idempotencyKey !== undefined) {
    if (old.accountId !== request.accountId || old.idempotencyKey !== request.idempotencyKey || old.identityJson !== request.identityJson ||
        old.payloadFingerprint !== request.payloadFingerprint) return false;
    if (old.reservationToken === (request.reservationToken ?? null)) return true;
    const tokenUpdated = await withDatabaseWrite(() => db.run(sql`UPDATE laps SET online_reservation_token=${request.reservationToken ?? null}
      WHERE id=${lapId} AND online_upload_blocked_reason IS NULL
        AND online_account_id=${request.accountId} AND online_idempotency_key=${request.idempotencyKey}
        AND online_identity_json=${request.identityJson} AND online_payload_fingerprint=${request.payloadFingerprint}
        AND online_reservation_token IS ${old.reservationToken} AND EXISTS(SELECT 1 FROM online_fastest_combo_laps WHERE lap_id=laps.id)`));
    return tokenUpdated.rowsAffected === 1;
  }
  const result = await withDatabaseWrite(() => db.run(sql`UPDATE laps SET online_account_id=${request.accountId},online_idempotency_key=${request.idempotencyKey},
    online_identity_json=${request.identityJson},online_payload_fingerprint=${request.payloadFingerprint},online_reservation_token=${request.reservationToken ?? null}
    WHERE id=${lapId} AND online_upload_blocked_reason IS NULL
      AND online_account_id IS NULL AND online_idempotency_key IS NULL AND online_identity_json IS NULL
      AND online_payload_fingerprint IS NULL AND online_reservation_token IS NULL
      AND EXISTS(SELECT 1 FROM online_fastest_combo_laps w WHERE w.lap_id=laps.id)
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=laps.session_id AND s.owner_user_id=${request.accountId}
        AND s.recording_origin='native_capture' AND s.recording_installation_id=${getRecordingInstallationId()})`));
  return result.rowsAffected === 1;
}

export async function settleOnlineLapUpload(lapId: number, idempotencyKey: string, result: string, remoteJobId: string | null, uploadedAt: string | null): Promise<boolean> {
  if (!/^(success|[a-z][a-z0-9_]{0,63})$/.test(result) || (result === "success" && (!remoteJobId || !uploadedAt))) return false;
  const resultAt = uploadedAt ?? new Date().toISOString();
  const updated = await withDatabaseWrite(() => db.run(sql`UPDATE laps SET online_upload_result=${result},online_remote_job_id=${remoteJobId},
    online_uploaded_at=${result === "success" ? uploadedAt : null},online_result_at=${resultAt},online_retry_after=NULL
    WHERE id=${lapId} AND online_idempotency_key=${idempotencyKey} AND online_upload_result IS NULL`));
  return updated.rowsAffected === 1;
}

export async function setOnlineLapRetryAfter(lapId: number, idempotencyKey: string, retryAfter: string | null): Promise<boolean> {
  const updated = await withDatabaseWrite(() => db.run(sql`UPDATE laps SET online_retry_after=${retryAfter}
    WHERE id=${lapId} AND online_idempotency_key=${idempotencyKey} AND online_upload_result IS NULL`));
  return updated.rowsAffected === 1;
}

export async function getOnlineLapUploadStatus(accountId: string): Promise<{ queued: number; rejected: number; lastSyncedAt: string | null }> {
  if (!accountId || await getLocalAccountOwner() !== accountId) return { queued: 0, rejected: 0, lastSyncedAt: null };
  const candidates = await readDb.all<UploadRow>(sql`SELECT ${selectWinnerFields},s.owner_user_id AS accountId,s.original_activity_id AS originalActivityId,l.lap_guid AS lapGuid,
    l.online_upload_result AS result,l.online_idempotency_key AS idempotencyKey,l.online_identity_json AS identityJson,
    l.online_payload_fingerprint AS payloadFingerprint,l.online_reservation_token AS reservationToken,l.online_remote_job_id AS remoteJobId,
    l.online_uploaded_at AS uploadedAt,l.online_retry_after AS retryAfter,l.driver_attribution_stints AS stintsJson,
    l.source_clock_domain AS sourceClockDomain,l.source_lap_start_ms AS sourceLapStartMs,l.source_lap_end_ms AS sourceLapEndMs,
    l.is_valid AS sourceValid,s.recording_installation_id AS installationId ${eligibleJoins}
    WHERE ${eligibleWhere} AND s.owner_user_id=${accountId} AND l.online_upload_result IS NULL`);
  const rejected = await readDb.all<{ rejected: number }>(sql`SELECT COUNT(*) AS rejected FROM laps WHERE online_account_id=${accountId} AND online_upload_result IS NOT NULL AND online_upload_result<>'success'`);
  const synced = await readDb.all<{ lastSyncedAt: string | null }>(sql`SELECT MAX(online_uploaded_at) AS lastSyncedAt FROM laps WHERE online_account_id=${accountId} AND online_upload_result='success'`);
  return { queued: candidates.filter(row => eligible(row, getRecordingInstallationId()) && Number.isSafeInteger(row.lapTimeMs) && row.lapTimeMs > 0).length,
    rejected: Number(rejected[0]?.rejected ?? 0), lastSyncedAt: synced[0]?.lastSyncedAt ?? null };
}
