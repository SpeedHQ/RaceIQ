import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stat as statFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { z } from "zod";
import { client } from "../db/index";
import { ClassificationMigrationCursorSchema } from "@raceiq/shared/racing/laps/classification-migration";
import type {
  ClassificationMigrationRecording,
  ClassificationMigrationStatus,
} from "@raceiq/shared/racing/laps/classification-migration";

export const CLASSIFICATION_MIGRATION_VERSION = 1;
export type ClassificationBarrierName = "beforeTransaction" | "insideTransaction" | "afterCommitBeforeAggregates" | "duringDecodeBatch";
const MARK_CAPTURE_FACTS_DIRTY_SQL = `INSERT INTO dashboard_summary_state
  (session_id,source_revision,metadata_dirty,capture_dirty,capture_ready)
  SELECT id,1,1,1,1 FROM sessions
  WHERE raw_file=? AND ownership='mine'
    AND id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1)
  ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
    metadata_dirty=1,capture_dirty=1,capture_ready=1,updated_at=datetime('now')`;
let staleSourceCursor = "";

/** Cross-process crash barriers are inert unless E2E mode and a barrier directory are explicitly configured. */
export async function classificationMigrationBarrier(name: ClassificationBarrierName): Promise<void> {
  if (process.env.RACEIQ_E2E !== "1" || process.env.RACEIQ_CLASSIFICATION_TEST_BARRIER !== name) return;
  const dir = process.env.RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR;
  if (!dir) throw new Error("RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR is required for classification barriers");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.reached`), "reached");
  for (;;) {
    try { await access(join(dir, `${name}.release`)); return; }
    catch { await new Promise<void>((resolve) => setTimeout(resolve, 20)); }
  }
}

function recordingId(sourceKey: string): string {
  return `recording-${createHash("sha256").update(sourceKey).digest("hex").slice(0, 24)}`;
}
export function classificationSourceSignature(stats: Stats): string {
  return JSON.stringify([stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino]);
}

export async function invalidateClassificationMigrationSource(sourcePath: string): Promise<void> {
  const tx = await client.transaction("write");
  try {
    const sourceKey = `file:${sourcePath}`;
    const id = recordingId(sourceKey);
    const updated = await tx.execute({
      sql: `INSERT INTO classification_migration_recordings
        (recording_id,source_key,version,source_revision,result_revision,attempt,state,reason,source_signature)
        SELECT ?,?,?,1,0,0,'pending','source_changed',NULL
        WHERE EXISTS (SELECT 1 FROM sessions WHERE raw_file=? AND id<=(
          SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1
        ))
        ON CONFLICT(recording_id) DO UPDATE SET
          source_key=excluded.source_key,version=excluded.version,
          source_revision=classification_migration_recordings.source_revision+1,
          result_revision=0,attempt=0,
          state=CASE WHEN classification_migration_recordings.state='running' THEN 'running' ELSE 'pending' END,
          reason='source_changed',source_signature=NULL`,
      args: [id, sourceKey, CLASSIFICATION_MIGRATION_VERSION, sourcePath],
    });
    if (Number(updated.rowsAffected) === 0) {
      const removed = await tx.execute({
        sql: "DELETE FROM classification_migration_recordings WHERE recording_id=? AND source_key=?",
        args: [id, sourceKey],
      });
      if (Number(removed.rowsAffected) > 0) await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
      await tx.commit();
      return;
    }
    await tx.execute({ sql: MARK_CAPTURE_FACTS_DIRTY_SQL, args: [sourcePath] });
    await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function invalidateStaleCompletedClassificationSources(
  shouldDefer: () => boolean = () => false,
): Promise<boolean> {
  if (shouldDefer()) return true;
  const pageSize = 25;
  const completed = await client.execute({
    sql: `SELECT recording_id,source_key,source_signature
      FROM classification_migration_recordings
      WHERE version=? AND state='completed' AND recording_id>?
      ORDER BY recording_id LIMIT ?`,
    args: [CLASSIFICATION_MIGRATION_VERSION, staleSourceCursor, pageSize],
  });
  if (!completed.rows.length) {
    staleSourceCursor = "";
    return false;
  }
  for (const row of completed.rows) {
    if (shouldDefer()) return true;
    const sourceKey = String(row.source_key);
    if (sourceKey.startsWith("file:")) {
      let signature: string | null = null;
      try { signature = classificationSourceSignature(await statFile(sourceKey.slice(5))); }
      catch { /* Missing source invalidates completed outcome; worker will record attention. */ }
      if (row.source_signature == null || signature !== String(row.source_signature)) {
        const sourcePath = sourceKey.slice(5);
        const tx = await client.transaction("write");
        try {
          const updated = await tx.execute({
            sql: `UPDATE classification_migration_recordings SET state='pending',source_revision=source_revision+1,
              source_signature=NULL,reason='source_changed'
              WHERE recording_id=? AND state='completed' AND source_signature IS ?`,
            args: [String(row.recording_id), row.source_signature ?? null],
          });
          if (Number(updated.rowsAffected) > 0) {
            await tx.execute({ sql: MARK_CAPTURE_FACTS_DIRTY_SQL, args: [sourcePath] });
            await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
          }
          await tx.commit();
        } catch (error) {
          await tx.rollback();
          throw error;
        }
      }
    }
    staleSourceCursor = String(row.recording_id);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (completed.rows.length < pageSize) {
    staleSourceCursor = "";
    return false;
  }
  return true;
}

export async function hasTerminalMigrationCaptureFailure(sessionId: number): Promise<boolean> {
  const rows = await client.execute({
    sql: `SELECT 1 FROM sessions s
      JOIN classification_migration_recordings r
        ON r.source_key=CASE WHEN s.raw_file IS NULL THEN 'session:' || s.id ELSE 'file:' || s.raw_file END
      WHERE s.id=? AND s.id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1)
        AND r.version=? AND r.state IN ('limited','failed')
        AND r.reason IN ('corrupt_source','insufficient_evidence') LIMIT 1`,
    args: [sessionId, CLASSIFICATION_MIGRATION_VERSION],
  });
  return rows.rows.length > 0;
}

/** Discover immutable source groups, including NULL/missing paths, without exposing paths in API identifiers. */
export async function reconcileClassificationMigrationInventory(options: { resetInterrupted?: boolean } = {}): Promise<void> {
  const initialization = await client.transaction("write");
  let cutoff: number;
  try {
    const meta = await initialization.execute("SELECT version,cutoff_session_id FROM classification_migration_meta WHERE id=1");
    cutoff = Number(meta.rows[0]?.cutoff_session_id ?? 0);
    let changed = false;
    if (Number(meta.rows[0]?.version ?? -1) !== CLASSIFICATION_MIGRATION_VERSION) {
      const maxId = await initialization.execute("SELECT COALESCE(MAX(id),0) AS id FROM sessions");
      cutoff = Number(maxId.rows[0]?.id ?? 0);
      await initialization.execute({
        sql: "UPDATE classification_migration_meta SET version=?,cutoff_session_id=? WHERE id=1",
        args: [CLASSIFICATION_MIGRATION_VERSION, cutoff],
      });
      changed = true;
    }
    if (options.resetInterrupted) {
      const reset = await initialization.execute("UPDATE classification_migration_recordings SET state='pending',reason=NULL WHERE state='running'");
      changed ||= Number(reset.rowsAffected) > 0;
    }
    if (changed) await initialization.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await initialization.commit();
  } catch (error) {
    await initialization.rollback();
    throw error;
  }

  const pageSize = 25;
  let afterId = 0;
  while (true) {
    const tx = await client.transaction("write");
    let pageLength = 0;
    try {
      const rows = await tx.execute({
        sql: "SELECT id,raw_file FROM sessions WHERE id>? AND id<=? ORDER BY id LIMIT ?",
        args: [afterId, cutoff, pageSize],
      });
      pageLength = rows.rows.length;
      const groups = new Set<string>();
      for (const row of rows.rows) {
        const id = Number(row.id);
        const rawFile = row.raw_file == null ? null : String(row.raw_file);
        groups.add(rawFile ? `file:${rawFile}` : `session:${id}`);
        afterId = id;
      }
      let changed = false;
      for (const sourceKey of groups) {
        const id = recordingId(sourceKey);
        const prior = await tx.execute({
          sql: "SELECT version FROM classification_migration_recordings WHERE recording_id=?",
          args: [id],
        });
        if (Number(prior.rows[0]?.version ?? -1) === CLASSIFICATION_MIGRATION_VERSION) continue;
        await tx.execute({
          sql: `INSERT INTO classification_migration_recordings
            (recording_id,source_key,version,source_revision,result_revision,attempt,state,reason)
            VALUES(?,?,?,1,0,0,'pending',NULL)
            ON CONFLICT(recording_id) DO UPDATE SET
              version=excluded.version,
              source_signature=CASE WHEN classification_migration_recordings.version!=excluded.version
                THEN NULL ELSE classification_migration_recordings.source_signature END,
              source_revision=CASE WHEN classification_migration_recordings.version!=excluded.version
                THEN classification_migration_recordings.source_revision+1 ELSE classification_migration_recordings.source_revision END,
              result_revision=CASE WHEN classification_migration_recordings.version!=excluded.version
                THEN 0 ELSE classification_migration_recordings.result_revision END,
              attempt=CASE WHEN classification_migration_recordings.version!=excluded.version
                THEN 0 ELSE classification_migration_recordings.attempt END,
              state=CASE WHEN classification_migration_recordings.version!=excluded.version
                THEN 'pending' ELSE classification_migration_recordings.state END,
              reason=CASE WHEN classification_migration_recordings.version!=excluded.version
                THEN NULL ELSE classification_migration_recordings.reason END`,
          args: [id, sourceKey, CLASSIFICATION_MIGRATION_VERSION],
        });
        changed = true;
      }
      if (changed) await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    if (pageLength < pageSize) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const cleanup = await client.transaction("write");
  try {
    const removed = await cleanup.execute({
      sql: `DELETE FROM classification_migration_recordings WHERE NOT EXISTS (
        SELECT 1 FROM sessions s WHERE s.id<=? AND
          (CASE WHEN s.raw_file IS NULL THEN 'session:' || s.id ELSE 'file:' || s.raw_file END)=classification_migration_recordings.source_key
      )`,
      args: [cutoff],
    });
    if (Number(removed.rowsAffected) > 0) await cleanup.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    await cleanup.commit();
  } catch (error) {
    await cleanup.rollback();
    throw error;
  }
}

function migrationStatusFrom(
  counts: { state: unknown; count: unknown }[],
  revision: number,
  aggregatesPending: boolean,
): ClassificationMigrationStatus {
  const values = new Map(counts.map((row) => [String(row.state), Number(row.count)]));
  const pending = values.get("pending") ?? 0;
  const running = values.get("running") ?? 0;
  const completed = values.get("completed") ?? 0;
  const limited = values.get("limited") ?? 0;
  const failed = values.get("failed") ?? 0;
  const total = pending + running + completed + limited + failed;
  const status = total === 0 ? "idle" : pending || running || aggregatesPending ? "running" : limited || failed ? "attention" : "complete";
  return { version: CLASSIFICATION_MIGRATION_VERSION, revision, status, total, pending, running, completed, limited, failed, aggregatesPending };
}

export async function getClassificationMigrationStatus(): Promise<ClassificationMigrationStatus> {
  const tx = await client.transaction("read");
  try {
    const counts = await tx.execute({
      sql: "SELECT state, COUNT(*) AS count FROM classification_migration_recordings WHERE version=? GROUP BY state",
      args: [CLASSIFICATION_MIGRATION_VERSION],
    });
    const meta = await tx.execute("SELECT revision FROM classification_migration_meta WHERE id=1");
    const dirty = await tx.execute("SELECT 1 FROM dashboard_summary_state WHERE metadata_dirty=1 OR capture_dirty=1 LIMIT 1");
    const result = migrationStatusFrom(
      counts.rows.map((row) => ({ state: row.state, count: row.count })),
      Number(meta.rows[0]?.revision ?? 0),
      dirty.rows.length > 0,
    );
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

type MigrationCursor = z.infer<typeof ClassificationMigrationCursorSchema>;
export async function listClassificationMigrationRecordings(limit: number, cursor?: string): Promise<{ revision: number; recordings: ClassificationMigrationRecording[]; nextCursor: string | null } | null> {
  const tx = await client.transaction("read");
  try {
    const counts = await tx.execute({
      sql: "SELECT state, COUNT(*) AS count FROM classification_migration_recordings WHERE version=? GROUP BY state",
      args: [CLASSIFICATION_MIGRATION_VERSION],
    });
    const meta = await tx.execute("SELECT revision,cutoff_session_id FROM classification_migration_meta WHERE id=1");
    const cutoff = Number(meta.rows[0]?.cutoff_session_id ?? 0);
    const dirty = await tx.execute("SELECT 1 FROM dashboard_summary_state WHERE metadata_dirty=1 OR capture_dirty=1 LIMIT 1");
    const status = migrationStatusFrom(
      counts.rows.map((row) => ({ state: row.state, count: row.count })),
      Number(meta.rows[0]?.revision ?? 0),
      dirty.rows.length > 0,
    );
    let after = "";
    if (cursor) {
      let decoded: MigrationCursor;
      try { decoded = ClassificationMigrationCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
      catch { throw new Error("Invalid cursor"); }
      if (decoded.revision !== status.revision) {
        await tx.rollback();
        return null;
      }
      after = decoded.after;
    }
    const rows = await tx.execute({
      sql: "SELECT recording_id,source_key,state,reason FROM classification_migration_recordings WHERE version=? AND state IN ('pending','running','limited','failed') AND recording_id>? ORDER BY recording_id LIMIT ?",
      args: [CLASSIFICATION_MIGRATION_VERSION, after, limit + 1],
    });
    const page = rows.rows.slice(0, limit);
    const recordings = [];
    for (const row of page) {
      const sourceKey = String(row.source_key);
      const ids = sourceKey.startsWith("file:")
        ? await tx.execute({ sql: "SELECT id FROM sessions WHERE raw_file=? AND id<=? ORDER BY id", args: [sourceKey.slice(5), cutoff] })
        : { rows: [{ id: sourceKey.slice("session:".length) }] };
      recordings.push({
        recordingId: String(row.recording_id),
        sessionIds: ids.rows.map((value) => Number(value.id)),
        state: String(row.state) as ClassificationMigrationRecording["state"],
        reason: row.reason == null ? null : String(row.reason) as ClassificationMigrationRecording["reason"],
        retryable: row.state === "limited" || row.state === "failed",
      });
    }
    const hasMore = rows.rows.length > limit;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ revision: status.revision, after: String(page.at(-1)?.recording_id ?? after) })).toString("base64url")
      : null;
    await tx.commit();
    return { revision: status.revision, recordings, nextCursor };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

export async function retryClassificationMigrationRecording(id: string): Promise<"pending" | "running" | "completed" | null> {
  const tx = await client.transaction("write");
  try {
    const rows = await tx.execute({
      sql: "SELECT state,source_key FROM classification_migration_recordings WHERE recording_id=?",
      args: [id],
    });
    const state = rows.rows[0]?.state;
    if (state === undefined) {
      await tx.commit();
      return null;
    }
    if (state === "completed" || state === "running" || state === "pending") {
      await tx.commit();
      return state;
    }
    const updated = await tx.execute({
      sql: "UPDATE classification_migration_recordings SET state='pending',reason=NULL,source_signature=NULL WHERE recording_id=? AND state IN ('limited','failed')",
      args: [id],
    });
    if (Number(updated.rowsAffected) > 0) {
      const sourceKey = String(rows.rows[0]?.source_key ?? "");
      if (sourceKey.startsWith("file:")) {
        await tx.execute({ sql: MARK_CAPTURE_FACTS_DIRTY_SQL, args: [sourceKey.slice(5)] });
      }
      await tx.execute("UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1");
    }
    await tx.commit();
    return "pending";
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
