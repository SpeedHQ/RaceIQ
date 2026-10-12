import type { CanonicalEligibility } from "../integrations/raceiq-online/selection";
import { createClient, type Client } from "@libsql/client/sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";

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
  eligibilityProofId: string;
  status: "pending" | "dispatching" | "transmitted" | "withdrawn" | "rejected" | "ambiguous";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
};

export type EnqueueOutboxJob = Pick<OutboxJob,
  "accountId" | "accountEpoch" | "gameId" | "trackId" | "carId" | "lapId" | "lapTimeMs"
> & { eligibility: CanonicalEligibility };

let client: Client | null = null;
let initPromise: Promise<void> | null = null;

function getClient(): Client {
  if (client) return client;
  const dataDir = resolveDataDir();
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
      row_id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_epoch TEXT NOT NULL,
      game_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      car_id TEXT NOT NULL,
      lap_id INTEGER NOT NULL,
      lap_time_ms INTEGER NOT NULL CHECK (lap_time_ms > 0),
      status TEXT NOT NULL CHECK (status IN ('pending','dispatching','transmitted','withdrawn','rejected','ambiguous')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_error_code TEXT,
      eligibility_proof_id TEXT NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_raceiq_online_outbox_due
      ON raceiq_online_outbox(account_id, account_epoch, status, next_attempt_at)`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raceiq_online_outbox_pending_track
      ON raceiq_online_outbox(account_id, account_epoch, game_id, track_id) WHERE status='pending'`);
    // A process exit during transport cannot prove non-delivery; never replay it.
    await db.execute(`UPDATE raceiq_online_outbox SET status='ambiguous', last_error_code='process_interrupted'
      WHERE status='dispatching'`);
  })();
  return initPromise;
}

function assertIdentity(value: string, name: string): void {
  if (!value || value.length > 256 || value.includes("\0")) throw new TypeError(`Invalid ${name}`);
}

function validateJob(job: EnqueueOutboxJob): void {
  for (const [name, value] of Object.entries({
    accountId: job.accountId,
    accountEpoch: job.accountEpoch,
    gameId: job.gameId,
    trackId: job.trackId,
    carId: job.carId,
  })) assertIdentity(value, name);
  if (!Number.isSafeInteger(job.lapId) || job.lapId <= 0) throw new TypeError("Invalid lapId");
  if (!Number.isSafeInteger(job.lapTimeMs) || job.lapTimeMs <= 0) throw new TypeError("Invalid lapTimeMs");
  assertIdentity(job.eligibility.proofId, "eligibilityProofId");
  if (job.eligibility.status !== "eligible" || job.eligibility.authority !== "raceiq-online-canonical" ||
      !job.eligibility.proofId || job.eligibility.proofId.length > 256) {
    throw new TypeError("Canonical eligibility proof required");
  }
}

/** Inserts/coalesces only pending work; terminal send history is immutable. */
export async function enqueueOutboxJob(job: EnqueueOutboxJob, now = Date.now()): Promise<"queued" | "coalesced" | "unchanged" | "full"> {
  validateJob(job);
  await ensureOutboxStorage();
  const tx = await getClient().transaction("write");
  try {
    const unresolved = await tx.execute({
      sql: `SELECT status FROM raceiq_online_outbox WHERE account_id=? AND game_id=? AND track_id=?
        AND status IN ('ambiguous','dispatching') LIMIT 1`,
      args: [job.accountId, job.gameId, job.trackId],
    });
    const previouslyTransmitted = await tx.execute({
      sql: `SELECT MIN(lap_time_ms) AS fastest_ms, MAX(lap_id=?) AS seen_lap FROM raceiq_online_outbox
        WHERE account_id=? AND game_id=? AND track_id=? AND status='transmitted'`,
      args: [job.lapId, job.accountId, job.gameId, job.trackId],
    });
    const prior = previouslyTransmitted.rows[0];
    if (unresolved.rows.length > 0 || (prior && prior.fastest_ms != null &&
        (Number(prior.seen_lap) === 1 || Number(prior.fastest_ms) <= job.lapTimeMs))) {
      await tx.commit();
      return "unchanged";
    }
    const existing = await tx.execute({
      sql: `SELECT row_id, lap_id, lap_time_ms, status FROM raceiq_online_outbox
        WHERE account_id=? AND account_epoch=? AND game_id=? AND track_id=?
        ORDER BY row_id DESC LIMIT 1`,
      args: [job.accountId, job.accountEpoch, job.gameId, job.trackId],
    });
    const row = existing.rows[0];
    if (row && String(row.status) === "dispatching") {
      await tx.commit();
      return "unchanged";
    }
    if (row && String(row.status) === "rejected" && Number(row.lap_id) === job.lapId) {
      await tx.commit();
      return "unchanged";
    }
    if (row && String(row.status) === "pending") {
      if (Number(row.lap_time_ms) <= job.lapTimeMs) {
        await tx.commit();
        return "unchanged";
      }
      await tx.execute({
        sql: `UPDATE raceiq_online_outbox SET car_id=?, lap_id=?, lap_time_ms=?, eligibility_proof_id=?, attempts=0,
          next_attempt_at=?, updated_at=?, last_error_code=NULL WHERE row_id=? AND status='pending'`,
        args: [job.carId, job.lapId, job.lapTimeMs, job.eligibility.proofId, now, now, Number(row.row_id)],
      });
      await tx.commit();
      return "coalesced";
    }
    await tx.execute({
      sql: `UPDATE raceiq_online_outbox SET status='withdrawn', updated_at=?, last_error_code='epoch_recomputed'
        WHERE account_id=? AND account_epoch<>? AND game_id=? AND track_id=? AND status='pending'`,
      args: [now, job.accountId, job.accountEpoch, job.gameId, job.trackId],
    });
    const count = await tx.execute({
      sql: "SELECT COUNT(*) AS count FROM raceiq_online_outbox WHERE account_id=?",
      args: [job.accountId],
    });
    const total = await tx.execute("SELECT COUNT(*) AS count FROM raceiq_online_outbox");
    if (Number(count.rows[0]?.count ?? 0) >= MAX_JOBS_PER_ACCOUNT ||
        Number(total.rows[0]?.count ?? 0) >= MAX_JOBS_TOTAL) {
      await tx.commit();
      return "full";
    }
    await tx.execute({
      sql: `INSERT INTO raceiq_online_outbox
        (account_id,account_epoch,game_id,track_id,car_id,lap_id,lap_time_ms,status,attempts,next_attempt_at,created_at,updated_at,eligibility_proof_id)
        VALUES (?,?,?,?,?,?,?,'pending',0,?,?,?,?)`,
      args: [job.accountId, job.accountEpoch, job.gameId, job.trackId, job.carId, job.lapId, job.lapTimeMs, now, now, now, job.eligibility.proofId],
    });
    await tx.commit();
    return "queued";
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function claimNextOutboxJob(input: { accountId: string; accountEpoch: string; now?: number }): Promise<OutboxJob | null> {
  assertIdentity(input.accountId, "accountId");
  assertIdentity(input.accountEpoch, "accountEpoch");
  await ensureOutboxStorage();
  const tx = await getClient().transaction("write");
  try {
    const result = await tx.execute({
      sql: `SELECT * FROM raceiq_online_outbox WHERE account_id=? AND account_epoch=?
        AND status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT 1`,
      args: [input.accountId, input.accountEpoch, input.now ?? Date.now()],
    });
    const row = result.rows[0];
    if (!row) {
      await tx.commit();
      return null;
    }
    const claimed = await tx.execute({
      sql: `UPDATE raceiq_online_outbox SET status='dispatching', attempts=attempts+1, updated_at=?
        WHERE row_id=? AND status='pending'`,
      args: [input.now ?? Date.now(), Number(row.row_id)],
    });
    if (Number(claimed.rowsAffected ?? 0) !== 1) {
      await tx.commit();
      return null;
    }
    await tx.commit();
    return {
      rowId: Number(row.row_id),
      accountId: String(row.account_id),
      accountEpoch: String(row.account_epoch),
      gameId: String(row.game_id),
      trackId: String(row.track_id),
      carId: String(row.car_id),
      lapId: Number(row.lap_id),
      lapTimeMs: Number(row.lap_time_ms),
      eligibilityProofId: String(row.eligibility_proof_id),
      status: "dispatching",
      attempts: Number(row.attempts) + 1,
      nextAttemptAt: Number(row.next_attempt_at),
      createdAt: Number(row.created_at),
      updatedAt: input.now ?? Date.now(),
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function settleOutboxJob(input: {
  job: OutboxJob;
  status: "transmitted" | "withdrawn" | "rejected" | "ambiguous" | "pending";
  nextAttemptAt?: number;
  errorCode?: string | null;
  now?: number;
}): Promise<boolean> {
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `UPDATE raceiq_online_outbox SET status=?, next_attempt_at=?, updated_at=?, last_error_code=?
      WHERE row_id=? AND account_id=? AND account_epoch=? AND status='dispatching'`,
    args: [input.status, input.nextAttemptAt ?? 0, input.now ?? Date.now(), input.errorCode ?? null,
      input.job.rowId, input.job.accountId, input.job.accountEpoch],
  });
  return Number(result.rowsAffected ?? 0) === 1;
}

/** Restrictive transition withdraws queued work permanently; it cannot be re-enabled by stale intent. */
export async function withdrawUnsentOutboxJobs(accountId: string, accountEpoch: string, now = Date.now()): Promise<number> {
  assertIdentity(accountId, "accountId");
  assertIdentity(accountEpoch, "accountEpoch");
  await ensureOutboxStorage();
  const result = await getClient().execute({
    sql: `UPDATE raceiq_online_outbox SET status='withdrawn', updated_at=?, last_error_code='dispatch_barrier'
      WHERE account_id=? AND account_epoch=? AND status='pending'`,
    args: [now, accountId, accountEpoch],
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
    sql: `SELECT status, COUNT(*) AS count FROM raceiq_online_outbox
      WHERE account_id=? AND (account_epoch=? OR status IN ('dispatching','transmitted','withdrawn','rejected','ambiguous'))
      GROUP BY status`,
    args: [accountId, accountEpoch],
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
