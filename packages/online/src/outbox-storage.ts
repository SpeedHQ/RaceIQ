import { randomFillSync } from "node:crypto";
import { createClient, type Client } from "@libsql/client/sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOnlineDataDir } from "./runtime";
import type { OnlineLapIdentity } from "./payload";
import type { UploadItem, OnlineErrorCode } from "./contracts";
function uuidV7(now = Date.now()): string {
  const bytes = randomFillSync(new Uint8Array(16));
  const timestamp = BigInt(now);
  for (let i = 5; i >= 0; i--) bytes[5 - i] = Number((timestamp >> BigInt(i * 8)) & 255n);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function toOutboxJob(row: Record<string, unknown>, status = String(row.status)): OutboxJob {
  return {
    rowId: Number(row.row_id), accountId: String(row.account_id), accountEpoch: String(row.account_epoch),
    gameId: String(row.game_id), trackId: String(row.track_id), carId: String(row.car_id),
    lapId: Number(row.lap_id), lapTimeMs: Number(row.lap_time_ms),
    identity: row.identity_json == null ? null : JSON.parse(String(row.identity_json)) as OnlineLapIdentity,
    uploadKey: row.upload_key == null ? null : String(row.upload_key),
    payloadFingerprint: row.payload_fingerprint == null ? null : String(row.payload_fingerprint),
    recordingPath: row.recording_path == null ? null : String(row.recording_path),
    setupPath: row.setup_path == null ? null : String(row.setup_path),
    reservationToken: row.reservation_token == null ? null : String(row.reservation_token),
    remoteJobId: row.remote_job_id == null ? null : String(row.remote_job_id),
    status: status as OutboxJob["status"], attempts: Number(row.attempts),
    retryNotBeforeAt: Number(row.retry_not_before_at ?? 0), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

const MAX_JOBS_PER_ACCOUNT = 1_000;
const MAX_JOBS_TOTAL = 10_000;
const DATABASE_FILE = "raceiq-online-outbox.db";

export type OutboxJob = {
  rowId: number;
  accountId: string;
  accountEpoch: string;
  gameId: string;
  trackId: string;
  carId: string;
  lapId: number;
  lapTimeMs: number;
  identity: OnlineLapIdentity | null;
  uploadKey: string | null;
  payloadFingerprint: string | null;
  recordingPath: string | null;
  setupPath: string | null;
  reservationToken: string | null;
  remoteJobId: string | null;
  status: "pending" | "dispatching" | "transmitted" | "withdrawn" | "rejected" | "ambiguous";
  attempts: number;
  retryNotBeforeAt: number;
  createdAt: number;
  updatedAt: number;
};

export type RetiredOutboxPayload = {
  retiredId: number | null;
  rowId: number;
  recordingPath: string | null;
  setupPath: string | null;
};

export type EnqueueOutboxJob = Pick<OutboxJob,
  "accountId" | "accountEpoch" | "gameId" | "trackId" | "carId" | "lapId" | "lapTimeMs"
> & { identity: OnlineLapIdentity };

let client: Client | null = null;
let initPromise: Promise<void> | null = null;

function getClient(): Client {
  if (client) return client;
  const dataDir = resolveOnlineDataDir();
  mkdirSync(dataDir, { recursive: true });
  client = createClient({ url: `file:${join(dataDir, DATABASE_FILE)}` });
  return client;
}

export function ensureOutboxStorage(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const db = getClient();
    await db.execute("PRAGMA journal_mode=WAL");
    await db.execute("PRAGMA synchronous=FULL");
    await db.execute(`CREATE TABLE IF NOT EXISTS raceiq_online_outbox (
      row_id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, account_epoch TEXT NOT NULL,
      game_id TEXT NOT NULL, track_id TEXT NOT NULL, car_id TEXT NOT NULL, lap_id INTEGER NOT NULL,
      lap_time_ms INTEGER NOT NULL CHECK (lap_time_ms > 0),
      status TEXT NOT NULL CHECK (status IN ('pending','dispatching','transmitted','withdrawn','rejected','ambiguous')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), retry_not_before_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error_code TEXT
    )`);
    await db.execute("CREATE TABLE IF NOT EXISTS raceiq_online_outbox_migrations (version INTEGER PRIMARY KEY)");
    await db.execute(`CREATE TABLE IF NOT EXISTS raceiq_online_retired_payloads (
      retired_id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL, recording_path TEXT, setup_path TEXT)`);
    const migrated = await db.execute("SELECT version FROM raceiq_online_outbox_migrations WHERE version=1");
    if (migrated.rows.length === 0) {
      const columns = ["upload_key TEXT", "payload_fingerprint TEXT", "recording_path TEXT", "setup_path TEXT",
        "reservation_token TEXT", "remote_job_id TEXT", "transmitted_at INTEGER"];
      for (const column of columns) {
        try { await db.execute(`ALTER TABLE raceiq_online_outbox ADD COLUMN ${column}`); }
        catch (error) {
          if (!String(error).includes("duplicate column")) throw error;
        }
      }
      await db.execute("INSERT INTO raceiq_online_outbox_migrations(version) VALUES (1)");
    }
    const migrated2 = await db.execute("SELECT version FROM raceiq_online_outbox_migrations WHERE version=2");
    if (migrated2.rows.length === 0) {
      const tx = await db.transaction("write");
      try {
        const columns = await tx.execute("PRAGMA table_info(raceiq_online_outbox)");
        if (columns.rows.some(row => row.name === "eligibility_proof_id")) {
          await tx.execute("ALTER TABLE raceiq_online_outbox DROP COLUMN eligibility_proof_id");
        }
        await tx.execute("UPDATE raceiq_online_outbox SET transmitted_at=updated_at WHERE status='transmitted' AND transmitted_at IS NULL");
        await tx.execute("INSERT INTO raceiq_online_outbox_migrations(version) VALUES (2)");
        await tx.commit();
      } catch (cause) { await tx.rollback(); throw cause; }
    }
    const migrated3 = await db.execute("SELECT version FROM raceiq_online_outbox_migrations WHERE version=3");
    if (migrated3.rows.length === 0) {
      const tx = await db.transaction("write");
      try {
        const columns = await tx.execute("PRAGMA table_info(raceiq_online_outbox)");
        await tx.execute("DROP INDEX IF EXISTS idx_raceiq_online_outbox_due");
        if (!columns.rows.some(row => row.name === "retry_not_before_at")) {
          await tx.execute("ALTER TABLE raceiq_online_outbox ADD COLUMN retry_not_before_at INTEGER NOT NULL DEFAULT 0");
          if (columns.rows.some(row => row.name === "next_attempt_at")) {
            await tx.execute("UPDATE raceiq_online_outbox SET retry_not_before_at=next_attempt_at");
            await tx.execute("ALTER TABLE raceiq_online_outbox DROP COLUMN next_attempt_at");
          }
        }
        await tx.execute("INSERT INTO raceiq_online_outbox_migrations(version) VALUES (3)");
        await tx.commit();
      } catch (cause) { await tx.rollback(); throw cause; }
    }
    await db.execute(`UPDATE raceiq_online_outbox SET status='ambiguous',last_error_code='activity_identity_ambiguous'
      WHERE status='pending' AND upload_key IS NULL`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_raceiq_online_outbox_due
      ON raceiq_online_outbox(account_id, account_epoch, status, retry_not_before_at)`);
    await db.execute("DROP INDEX IF EXISTS idx_raceiq_online_outbox_pending_track");
    await db.execute(`UPDATE raceiq_online_outbox SET status='pending',last_error_code=NULL
      WHERE status='dispatching' AND upload_key IS NOT NULL AND payload_fingerprint IS NULL
      AND recording_path IS NULL AND setup_path IS NULL AND reservation_token IS NULL AND remote_job_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM raceiq_online_outbox p WHERE p.status='pending'
        AND p.account_id=raceiq_online_outbox.account_id
        AND p.game_id=raceiq_online_outbox.game_id AND p.track_id=raceiq_online_outbox.track_id AND p.car_id=raceiq_online_outbox.car_id)`);
    await db.execute(`UPDATE raceiq_online_outbox SET status='withdrawn',last_error_code='superseded_interrupted'
      WHERE status='dispatching' AND upload_key IS NOT NULL AND payload_fingerprint IS NULL
      AND recording_path IS NULL AND setup_path IS NULL AND reservation_token IS NULL AND remote_job_id IS NULL
      AND EXISTS (SELECT 1 FROM raceiq_online_outbox p WHERE p.status='pending'
        AND p.account_id=raceiq_online_outbox.account_id
        AND p.game_id=raceiq_online_outbox.game_id AND p.track_id=raceiq_online_outbox.track_id AND p.car_id=raceiq_online_outbox.car_id)`);
    await db.execute(`UPDATE raceiq_online_outbox SET status='pending',last_error_code=NULL
      WHERE status='ambiguous' AND last_error_code='process_interrupted' AND upload_key IS NOT NULL
      AND payload_fingerprint IS NULL AND recording_path IS NULL AND setup_path IS NULL
      AND reservation_token IS NULL AND remote_job_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM raceiq_online_outbox p WHERE p.status='pending'
        AND p.account_id=raceiq_online_outbox.account_id
        AND p.game_id=raceiq_online_outbox.game_id AND p.track_id=raceiq_online_outbox.track_id AND p.car_id=raceiq_online_outbox.car_id)`);
    await db.execute(`UPDATE raceiq_online_outbox SET status='withdrawn',last_error_code='superseded_interrupted'
      WHERE status='ambiguous' AND last_error_code='process_interrupted' AND upload_key IS NOT NULL
      AND payload_fingerprint IS NULL AND recording_path IS NULL AND setup_path IS NULL
      AND reservation_token IS NULL AND remote_job_id IS NULL AND EXISTS
      (SELECT 1 FROM raceiq_online_outbox p WHERE p.status='pending'
        AND p.account_id=raceiq_online_outbox.account_id
        AND p.game_id=raceiq_online_outbox.game_id AND p.track_id=raceiq_online_outbox.track_id AND p.car_id=raceiq_online_outbox.car_id)`);
    await db.execute(`UPDATE raceiq_online_outbox SET status='ambiguous', last_error_code='process_interrupted'
      WHERE status='dispatching'`);
    const columns = await db.execute("PRAGMA table_info(raceiq_online_outbox)");
    if (!columns.rows.some(row => row.name === "identity_json")) {
      await db.execute("ALTER TABLE raceiq_online_outbox ADD COLUMN identity_json TEXT");
    }
    await db.execute(`UPDATE raceiq_online_outbox SET status='ambiguous',last_error_code='activity_identity_ambiguous'
      WHERE identity_json IS NULL AND (status IN ('pending','dispatching') OR (status='ambiguous' AND last_error_code='legacy_identity_missing'))`);
    for (const column of ["validation_status TEXT NOT NULL DEFAULT 'not_requested'", "publication_status TEXT NOT NULL DEFAULT 'not_requested'", "remote_status_checked_at INTEGER NOT NULL DEFAULT 0"]) {
      const name = column.split(" ")[0]!;
      if (!columns.rows.some(row => row.name === name)) await db.execute(`ALTER TABLE raceiq_online_outbox ADD COLUMN ${column}`);
    }
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raceiq_online_outbox_pending_board
      ON raceiq_online_outbox(account_id,game_id,track_id,car_id) WHERE status='pending'`);
  })();
  return initPromise;
}

function assertIdentity(value: string, name: string): void {
  if (!value || value.length > 256 || value.includes("\0")) throw new TypeError(`Invalid ${name}`);
}

function validateJob(job: EnqueueOutboxJob): void {
  for (const [name, value] of Object.entries({
    accountId: job.accountId, accountEpoch: job.accountEpoch, gameId: job.gameId,
    trackId: job.trackId, carId: job.carId,
  })) assertIdentity(value, name);
  if (!Number.isSafeInteger(job.lapId) || job.lapId <= 0) throw new TypeError("Invalid lapId");
  if (!Number.isSafeInteger(job.lapTimeMs) || job.lapTimeMs <= 0) throw new TypeError("Invalid lapTimeMs");
  if (job.identity.ownerUserId !== job.accountId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.identity.lapGuid)
    || !job.identity.originalActivityId || !job.identity.sourceRevision || !job.identity.driverBindingId
    || !Number.isSafeInteger(job.identity.driverBindingRevision) || job.identity.driverBindingRevision < 1
    || (job.identity.sourceKind !== "native_capture" && job.identity.sourceKind !== "verified_portable")) throw new TypeError("Invalid immutable lap identity");
}

/** Inserts/coalesces only pending work; terminal send history is immutable. */
export async function enqueueOutboxJob(job:EnqueueOutboxJob,now=Date.now()):Promise<"queued"|"coalesced"|"unchanged"|"rejected"|"full"> {
  validateJob(job);
  await ensureOutboxStorage();
  const tx = await getClient().transaction("write");
  try {
    const unresolved = await tx.execute({ sql: `SELECT status FROM raceiq_online_outbox
      WHERE account_id=? AND game_id=? AND track_id=? AND car_id=? AND status IN ('ambiguous','dispatching') LIMIT 1`,
      args: [job.accountId, job.gameId, job.trackId, job.carId] });
    const priorSent = await tx.execute({ sql: `SELECT MIN(lap_time_ms) AS fastest_ms, MAX(lap_id=?) AS seen_lap
      FROM raceiq_online_outbox WHERE account_id=? AND game_id=? AND track_id=? AND car_id=? AND status='transmitted'`,
      args: [job.lapId, job.accountId, job.gameId, job.trackId, job.carId] });
    const prior = priorSent.rows[0];
    if (unresolved.rows.length || (prior?.fastest_ms != null &&
        (Number(prior.seen_lap) === 1 || Number(prior.fastest_ms) <= job.lapTimeMs))) {
      await tx.commit(); return "unchanged";
    }
    const rejectedLap = await tx.execute({ sql: `SELECT 1 FROM raceiq_online_outbox
      WHERE account_id=? AND game_id=? AND track_id=? AND car_id=? AND lap_id=? AND status='rejected' LIMIT 1`,
      args: [job.accountId, job.gameId, job.trackId, job.carId, job.lapId] });
    if(rejectedLap.rows.length){await tx.commit();return "rejected";}
    const existing = await tx.execute({ sql: `SELECT * FROM raceiq_online_outbox
      WHERE account_id=? AND game_id=? AND track_id=? AND car_id=? AND status='pending' ORDER BY row_id DESC LIMIT 1`,
      args: [job.accountId, job.gameId, job.trackId, job.carId] });
    const row = existing.rows[0];
    if (row && Number(row.lap_time_ms) <= job.lapTimeMs) { await tx.commit(); return "unchanged"; }
    if (row) {
      if (row.recording_path == null && row.setup_path == null) {
        await tx.execute({ sql: `UPDATE raceiq_online_outbox SET account_epoch=?,car_id=?,lap_id=?,lap_time_ms=?,
          upload_key=?,payload_fingerprint=NULL,reservation_token=NULL,attempts=0,retry_not_before_at=?,
          updated_at=?,last_error_code=NULL,identity_json=? WHERE row_id=? AND status='pending'`,
        args: [job.accountEpoch, job.carId, job.lapId, job.lapTimeMs, uuidV7(now), now, now, JSON.stringify(job.identity), Number(row.row_id)] });
        await tx.commit(); return "coalesced";
      }
      await tx.execute({ sql: `UPDATE raceiq_online_outbox SET status='withdrawn',updated_at=?,last_error_code='coalesced'
        WHERE row_id=? AND status='pending'`, args: [now, Number(row.row_id)] });
    }
    const count = await tx.execute({ sql: `SELECT COUNT(*) AS count FROM raceiq_online_outbox
      WHERE account_id=? AND status IN ('pending','dispatching','ambiguous')`, args: [job.accountId] });
    const total = await tx.execute(`SELECT COUNT(*) AS count FROM raceiq_online_outbox
      WHERE status IN ('pending','dispatching','ambiguous')`);
    if (Number(count.rows[0]?.count ?? 0) >= MAX_JOBS_PER_ACCOUNT || Number(total.rows[0]?.count ?? 0) >= MAX_JOBS_TOTAL) {
      await tx.commit(); return "full";
    }
    await tx.execute({ sql: `INSERT INTO raceiq_online_outbox
      (account_id,account_epoch,game_id,track_id,car_id,lap_id,lap_time_ms,status,attempts,retry_not_before_at,
       created_at,updated_at,upload_key,identity_json) VALUES (?,?,?,?,?,?,?,'pending',0,?,?,?,?,?)`,
    args: [job.accountId, job.accountEpoch, job.gameId, job.trackId, job.carId, job.lapId, job.lapTimeMs,
      now, now, now, uuidV7(now), JSON.stringify(job.identity)] });
    await tx.commit(); return "queued";
  } catch (error) { await tx.rollback(); throw error; }
}

export async function persistOutboxPayload(job: OutboxJob,
  payload: { fingerprint: string; recordingPath: string; setupPath: string | null },
  confirmedUnacceptedReservationToken?: string): Promise<OutboxJob | null> {
  assertIdentity(payload.fingerprint, "fingerprint"); assertIdentity(payload.recordingPath, "recordingPath");
  if (payload.setupPath) assertIdentity(payload.setupPath, "setupPath");
  await ensureOutboxStorage();
  const tx = await getClient().transaction("write");
  try {
    const result = await tx.execute({ sql: "SELECT * FROM raceiq_online_outbox WHERE row_id=? AND account_id=?",
      args: [job.rowId, job.accountId] });
    const row = result.rows[0];
    if (!row || ["withdrawn", "rejected", "transmitted"].includes(String(row.status))) { await tx.commit(); return null; }
    const changed = row.payload_fingerprint !== payload.fingerprint || row.recording_path !== payload.recordingPath ||
      row.setup_path !== payload.setupPath;
    const initialPayload = row.payload_fingerprint == null && row.recording_path == null && row.setup_path == null;
    const confirmedReplacement = changed && confirmedUnacceptedReservationToken != null &&
      row.reservation_token === confirmedUnacceptedReservationToken &&
      ["pending", "dispatching", "ambiguous"].includes(String(row.status));
    if (changed && String(row.status) !== "pending" && !initialPayload && !confirmedReplacement) {
      await tx.commit(); return null;
    }
    if (changed && String(row.status) === "pending" && confirmedUnacceptedReservationToken != null &&
        row.reservation_token !== confirmedUnacceptedReservationToken) { await tx.commit(); return null; }
    if (changed && !initialPayload) {
      const retiredRecording = row.recording_path != null && row.recording_path !== payload.recordingPath &&
        row.recording_path !== payload.setupPath ? String(row.recording_path) : null;
      const retiredSetup = row.setup_path != null && row.setup_path !== payload.recordingPath &&
        row.setup_path !== payload.setupPath ? String(row.setup_path) : null;
      if (retiredRecording || retiredSetup) {
        await tx.execute({
          sql: "INSERT INTO raceiq_online_retired_payloads(row_id,recording_path,setup_path) VALUES (?,?,?)",
          args: [job.rowId, retiredRecording, retiredSetup],
        });
      }
    }
    await tx.execute({ sql: `UPDATE raceiq_online_outbox SET payload_fingerprint=?,recording_path=?,setup_path=?,
      upload_key=CASE WHEN ? THEN ? ELSE upload_key END,reservation_token=CASE WHEN ? THEN NULL ELSE reservation_token END,
      status=CASE WHEN ? THEN 'pending' ELSE status END,updated_at=? WHERE row_id=? AND account_id=?`,
    args: [payload.fingerprint, payload.recordingPath, payload.setupPath, changed && !initialPayload ? 1 : 0,
      uuidV7(), changed ? 1 : 0, confirmedReplacement ? 1 : 0, Date.now(), job.rowId, job.accountId] });
    const updated = await tx.execute({ sql: "SELECT * FROM raceiq_online_outbox WHERE row_id=?", args: [job.rowId] });
    await tx.commit(); return toOutboxJob(updated.rows[0]!);
  } catch (error) { await tx.rollback(); throw error; }
}

export async function saveOutboxReservation(job: OutboxJob, reservationToken: string): Promise<boolean> {
  assertIdentity(reservationToken, "reservationToken"); await ensureOutboxStorage();
  const result = await getClient().execute({ sql: `UPDATE raceiq_online_outbox SET reservation_token=?,updated_at=?
    WHERE row_id=? AND account_id=? AND upload_key=? AND payload_fingerprint IS NOT NULL
    AND status IN ('pending','dispatching','ambiguous')`,
  args: [reservationToken, Date.now(), job.rowId, job.accountId, job.uploadKey] });
  return Number(result.rowsAffected ?? 0) === 1;
}

export async function recordOutboxAcceptance(job: OutboxJob, remoteJobId: string, now = Date.now()): Promise<boolean> {
  assertIdentity(remoteJobId, "remoteJobId"); await ensureOutboxStorage();
  const result = await getClient().execute({ sql: `UPDATE raceiq_online_outbox SET status='transmitted',
    remote_job_id=?,transmitted_at=COALESCE(transmitted_at,?),updated_at=?,retry_not_before_at=0,last_error_code=NULL,validation_status='pending',publication_status='pending'
    WHERE row_id=? AND account_id=? AND upload_key=? AND status IN ('dispatching','ambiguous')`,
  args: [remoteJobId, now, now, job.rowId, job.accountId, job.uploadKey] });
  return Number(result.rowsAffected ?? 0) === 1;
}


export async function listRetiredOutboxPayloads(limit = 100): Promise<RetiredOutboxPayload[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("Invalid limit");
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `SELECT NULL AS retired_id,row_id,recording_path,setup_path FROM raceiq_online_outbox
      WHERE status IN ('transmitted','withdrawn','rejected') AND (recording_path IS NOT NULL OR setup_path IS NOT NULL)
      UNION ALL SELECT retired_id,row_id,recording_path,setup_path FROM raceiq_online_retired_payloads
      ORDER BY row_id,retired_id LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((row) => ({
    retiredId: row.retired_id == null ? null : Number(row.retired_id),
    rowId: Number(row.row_id),
    recordingPath: row.recording_path == null ? null : String(row.recording_path),
    setupPath: row.setup_path == null ? null : String(row.setup_path),
  }));
}

export async function clearRetiredOutboxPayloads(payload: RetiredOutboxPayload): Promise<void> {
  if (!Number.isSafeInteger(payload.rowId) || payload.rowId <= 0 ||
      (payload.retiredId !== null && (!Number.isSafeInteger(payload.retiredId) || payload.retiredId <= 0))) {
    throw new TypeError("Invalid retired payload");
  }
  await ensureOutboxStorage();
  const tx = await getClient().transaction("write");
  try {
    if (payload.retiredId === null) {
      await tx.execute({
        sql: `UPDATE raceiq_online_outbox SET recording_path=NULL,setup_path=NULL
          WHERE row_id=? AND status IN ('transmitted','withdrawn','rejected')
          AND recording_path IS ? AND setup_path IS ?`,
        args: [payload.rowId, payload.recordingPath, payload.setupPath],
      });
    } else {
      await tx.execute({
        sql: "DELETE FROM raceiq_online_retired_payloads WHERE retired_id=? AND row_id=?",
        args: [payload.retiredId, payload.rowId],
      });
    }
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
}

export async function isCurrentOutboxPayloadPath(path: string): Promise<boolean> {
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `SELECT 1 FROM raceiq_online_outbox WHERE status IN ('pending','dispatching','ambiguous')
      AND (recording_path=? OR setup_path=?) LIMIT 1`,
    args: [path, path],
  });
  return result.rows.length > 0;
}

export async function getOutboxJob(rowId: number, accountId: string): Promise<OutboxJob | null> {
  await ensureOutboxStorage();
  const result = await getClient().execute({ sql: "SELECT * FROM raceiq_online_outbox WHERE row_id=? AND account_id=?",
    args: [rowId, accountId] });
  return result.rows[0] ? toOutboxJob(result.rows[0]) : null;
}

export async function listDeliverableOutboxJobs(accountId: string): Promise<OutboxJob[]> {
  assertIdentity(accountId, "accountId");
  await ensureOutboxStorage();
  const result = await getClient().execute({ sql: `SELECT * FROM raceiq_online_outbox
    WHERE account_id=? AND upload_key IS NOT NULL AND remote_job_id IS NULL
      AND (status='pending' OR (status='ambiguous' AND payload_fingerprint IS NOT NULL)) ORDER BY row_id`, args: [accountId] });
  return result.rows.map(row => toOutboxJob(row));
}

export async function beginOutboxAttempt(input: {
  rowId: number; accountId: string; accountEpoch: string; uploadKey: string; attempts: number;
}): Promise<OutboxJob | null> {
  assertIdentity(input.accountId, "accountId");
  assertIdentity(input.accountEpoch, "accountEpoch");
  await ensureOutboxStorage();
  const result = await getClient().execute({ sql: `UPDATE raceiq_online_outbox SET account_epoch=?,status='dispatching',
    attempts=?,updated_at=? WHERE row_id=? AND account_id=? AND upload_key=? AND remote_job_id IS NULL
    AND status IN ('pending','ambiguous','dispatching')`,
  args: [input.accountEpoch, input.attempts, Date.now(), input.rowId, input.accountId, input.uploadKey] });
  return Number(result.rowsAffected ?? 0) === 1 ? getOutboxJob(input.rowId, input.accountId) : null;
}

export async function settleOutboxDelivery(input: {
  job: OutboxJob; status: "withdrawn" | "rejected" | "ambiguous" | "pending";
  retryNotBeforeAt?: number; errorCode?: string | null; now?: number;
}): Promise<boolean> {
  await ensureOutboxStorage();
  const now = input.now ?? Date.now();
  const result = await getClient().execute({ sql: `UPDATE raceiq_online_outbox SET status=?,retry_not_before_at=?,
    updated_at=?,last_error_code=?
    WHERE row_id=? AND account_id=? AND account_epoch=? AND upload_key=? AND status='dispatching'`,
  args: [input.status, input.retryNotBeforeAt ?? 0, now, input.errorCode ?? null,
    input.job.rowId, input.job.accountId, input.job.accountEpoch, input.job.uploadKey] });
  return Number(result.rowsAffected ?? 0) === 1;
}

/** Restrictive transition withdraws queued work permanently; it cannot be re-enabled by stale intent. */
export async function withdrawUnsentOutboxJobs(accountId: string, accountEpoch: string, now = Date.now()): Promise<number> {
  assertIdentity(accountId, "accountId");
  assertIdentity(accountEpoch, "accountEpoch");
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `UPDATE raceiq_online_outbox SET status='withdrawn', updated_at=?, last_error_code='dispatch_barrier'
      WHERE account_id=? AND status='pending' AND remote_job_id IS NULL`,
    args: [now, accountId],
  });
  return Number(result.rowsAffected ?? 0);
}

/** Withdraw every queued row for a stable account across authorization epochs. */
export async function withdrawAccountOutboxJobs(accountId: string, now = Date.now()): Promise<number> {
  assertIdentity(accountId, "accountId");
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `UPDATE raceiq_online_outbox SET status='withdrawn',updated_at=?,last_error_code='dispatch_barrier'
      WHERE account_id=? AND status='pending' AND remote_job_id IS NULL`,
    args: [now, accountId],
  });
  return Number(result.rowsAffected ?? 0);
}

export async function countOutboxJobs(accountId: string, accountEpoch: string): Promise<{
  queued: number; inFlight: number; transmitted: number; withdrawn: number; rejected: number; ambiguous: number;
}> {
  assertIdentity(accountId, "accountId");
  assertIdentity(accountEpoch, "accountEpoch");
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `SELECT status, COUNT(*) AS count FROM raceiq_online_outbox WHERE account_id=? GROUP BY status`,
    args: [accountId],
  });
  const counts = { queued: 0, inFlight: 0, transmitted: 0, withdrawn: 0, rejected: 0, ambiguous: 0 };
  for (const row of result.rows) {
    const count = Number(row.count);
    switch (String(row.status)) {
      case "pending": counts.queued = count; break;
      case "dispatching": counts.inFlight = count; break;
      case "transmitted": counts.transmitted = count; break;
      case "withdrawn": counts.withdrawn = count; break;
      case "rejected": counts.rejected = count; break;
      case "ambiguous": counts.ambiguous = count; break;
    }
  }
  return counts;
}

/** Returns durable upload status scoped to an account, independent of authorization epoch. */
export async function getAccountOutboxStatus(accountId: string): Promise<{
  queued: number;
  inFlight: number;
  rejected: number;
  ambiguous: number;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
}> {
  assertIdentity(accountId, "accountId");
  await ensureOutboxStorage();
  const db = getClient();
  const result = await db.execute({
    sql: `SELECT
        COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(SUM(CASE WHEN status='dispatching' THEN 1 ELSE 0 END), 0) AS in_flight,
        COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN status='ambiguous' THEN 1 ELSE 0 END), 0) AS ambiguous,
        MAX(transmitted_at) AS last_synced_at,
        (SELECT last_error_code FROM raceiq_online_outbox AS unresolved
          WHERE unresolved.account_id=? AND unresolved.status IN ('pending','rejected','ambiguous')
            AND unresolved.last_error_code IS NOT NULL
          ORDER BY unresolved.updated_at DESC, unresolved.row_id DESC LIMIT 1) AS last_error_code
      FROM raceiq_online_outbox WHERE account_id=?`,
    args: [accountId, accountId],
  });
  const row = result.rows[0];
  const syncedAt = row.last_synced_at;
  return {
    queued: Number(row.queued),
    inFlight: Number(row.in_flight),
    rejected: Number(row.rejected),
    ambiguous: Number(row.ambiguous),
    lastSyncedAt: syncedAt == null ? null : new Date(Number(syncedAt)).toISOString(),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
  };
}

export interface UploadPageBoundary { time: number; id: string }
export async function readLapUploadItems(accountId: string, view: "queue" | "history", boundary: UploadPageBoundary | null, limit: number): Promise<UploadItem[]> {
  await ensureOutboxStorage();
  const terminal = view === "history";
  const direction = terminal ? "DESC" : "ASC";
  const comparison = terminal ? "<" : ">";
  const time = terminal ? "updated_at" : "created_at";
  const result = await getClient().execute({
    sql: `SELECT * FROM raceiq_online_outbox WHERE account_id=?
      AND status ${terminal ? "IN" : "NOT IN"} ('transmitted','rejected','withdrawn')
      ${boundary ? `AND (${time} ${comparison} ? OR (${time}=? AND ('lap:' || printf('%020d',row_id)) ${comparison} ?))` : ""}
      ORDER BY ${time} ${direction},row_id ${direction} LIMIT ?`,
    args: [accountId,...(boundary ? [boundary.time,boundary.time,boundary.id] : []),limit],
  });
  const iso = (value: unknown) => new Date(Number(value)).toISOString();
  return result.rows.map((row): UploadItem => {
    const job = toOutboxJob(row);
    const code = row.last_error_code;
    const errorCode: OnlineErrorCode = code === "rate_limited" ? code : code === "offline" ? code
      : code==="unsupported_recording_format"||code==="recording_too_large"||code==="recording_not_ready"?code
      : code==="f1_sanitization_failed"||code==="unsupported_game"||code==="ineligible_lap"?code
      : code==="driver_identity_required"||code==="mixed_driver_lap"||code==="activity_identity_ambiguous"?code
      : code==="activity_owner_conflict"||code==="lap_owner_conflict"||code==="lap_identity_conflict"?code:"service_unavailable";
    return {
      id: `lap:${String(job.rowId).padStart(20,"0")}`,kind: "lap",gameId: job.gameId,lapId: job.lapId,
      lapGuid: job.identity?.lapGuid ?? null,trackId: job.trackId,carId: job.carId,
      delivery: job.status === "transmitted" ? "accepted" : job.status === "dispatching" ? "uploading"
        : job.status === "pending" ? (job.retryNotBeforeAt>Date.now() ? "retry_wait" : "queued")
        : job.status === "withdrawn" && code === "coalesced" ? "superseded" : job.status,
      admittedAt: iso(job.createdAt),updatedAt: iso(job.updatedAt),settledAt: terminal ? iso(job.updatedAt) : null,
      attemptCount: job.attempts,nextAttemptAt: job.retryNotBeforeAt>Date.now() ? iso(job.retryNotBeforeAt) : null,
      acceptedAt: row.transmitted_at == null ? null : iso(row.transmitted_at),remoteJobId: job.remoteJobId,
      validation: row.validation_status as UploadItem["validation"],publication: row.publication_status as UploadItem["publication"],
      error: code == null ? null : { code: errorCode,retryable: job.status==="pending" || job.status==="ambiguous",retryAfter: job.retryNotBeforeAt>Date.now() ? iso(job.retryNotBeforeAt) : null },
      activityId: null,activityRevision: null,
    };
  });
}
export async function recordOutboxRemoteStatus(job: OutboxJob, validation: UploadItem["validation"], publication: UploadItem["publication"]): Promise<void> {
  await ensureOutboxStorage();
  await getClient().execute({ sql: `UPDATE raceiq_online_outbox SET validation_status=?,publication_status=?,remote_status_checked_at=?
    WHERE row_id=? AND account_id=? AND remote_job_id=? AND status='transmitted'`,
    args: [validation,publication,Date.now(),job.rowId,job.accountId,job.remoteJobId] });
}
export async function listAcceptedOutboxJobs(accountId: string, limit = 100): Promise<OutboxJob[]> {
  await ensureOutboxStorage();
  const result = await getClient().execute({ sql: `SELECT * FROM raceiq_online_outbox WHERE account_id=? AND status='transmitted'
    ORDER BY remote_status_checked_at,row_id LIMIT ?`,args: [accountId,limit] });
  return result.rows.map(row => toOutboxJob(row));
}
export async function closeOutboxStorage(): Promise<void> {
  if (initPromise) await initPromise;
  client?.close(); client=null; initPromise=null;
}
