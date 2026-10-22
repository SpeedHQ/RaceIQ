import type { Client, Transaction } from "@libsql/client";
import { client } from "@raceiq/backend-core/db/index";
import { PitEstimateRecordSchema, StintSummarySchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { GameIdSchema, type GameId } from "@raceiq/shared/games/ids";
import type { PitEstimateRecord, SourceOrder, StintSummary, StrategyHistoryUpdatedMessage } from "@raceiq/shared/racing/live/strategy";
import type { LapMetricContribution } from "./lap-metrics";
import type { StrategyTotals } from "./stint-accumulator";
import { publishStrategyHistory } from "./history-events";
import { z } from "zod";
import { withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";

export interface PersistStrategyLapInput {
  sessionId: number; driverKey: string; lapId: number; stintId: string; algorithmVersion: string;
  contribution: LapMetricContribution;
}

export class StaleStrategyIdentityError extends Error {}
async function assertStrategyIdentity(tx: Transaction, identity: Pick<StintSummary, "sessionId" | "gameId" | "carId" | "trackId" | "driverKey">): Promise<void> {
  const result = await tx.execute({ sql: "SELECT game_id,car_id,track_id,ownership FROM sessions WHERE id=?", args: [identity.sessionId] });
  const session = result.rows[0];
  if (!session || session.game_id !== identity.gameId || session.car_id !== identity.carId ||
    session.track_id !== identity.trackId || identity.driverKey === "local-player" && session.ownership !== "mine") {
    throw new StaleStrategyIdentityError("Strategy source identity changed");
  }
}
export async function strategyHistoryChanges(connection: Pick<Client, "execute">, scopes: readonly { gameId: string; driverKey: string }[]): Promise<StrategyHistoryUpdatedMessage[]> {
  const unique = new Set<string>();
  const changes: StrategyHistoryUpdatedMessage[] = [];
  for (const scope of scopes) {
    const key = `${scope.gameId}\0${scope.driverKey}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const result = await connection.execute({ sql: "SELECT revision FROM strategy_history_revisions WHERE game_id = ? AND driver_key = ?", args: [scope.gameId, scope.driverKey] });
    changes.push({ type: "strategy-history-updated", gameId: GameIdSchema.parse(scope.gameId), driverKey: scope.driverKey, historyRevision: Number(result.rows[0]?.revision ?? 0) });
  }
  return changes;
}
export function publishStrategyChanges(changes: readonly StrategyHistoryUpdatedMessage[]): void {
  for (const change of changes) publishStrategyHistory(change.gameId, change.driverKey, change.historyRevision);
}
async function writeStint(tx: Transaction, summary: StintSummary, totals: StrategyTotals): Promise<void> {
  await assertStrategyIdentity(tx, summary);
  await tx.execute({
    sql: `INSERT INTO strategy_stints(id,session_id,driver_key,ordinal,status,payload,totals,revision)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,payload=excluded.payload,totals=excluded.totals,revision=excluded.revision`,
    args: [summary.id,summary.sessionId,summary.driverKey,summary.ordinal,summary.status,JSON.stringify(summary),JSON.stringify(totals),summary.revision],
  });
}
/** A saved lap contributes once; source evidence, numerators and summary commit together. */
export async function persistStrategyLapMetrics(input: PersistStrategyLapInput, summary: StintSummary, totals: StrategyTotals, estimate?: PitEstimateRecord): Promise<boolean> {
  return withDatabaseWrite(async () => {
  const tx = await client.transaction("write");
  try {
    const existing = await tx.execute({ sql: "SELECT 1 FROM strategy_lap_metrics WHERE session_id=? AND driver_key=? AND lap_id=? AND algorithm_version=?", args: [input.sessionId,input.driverKey,input.lapId,input.algorithmVersion] });
    if (existing.rows.length) { await tx.commit(); return false; }
    await writeStint(tx, summary, totals);
    await tx.execute({
      sql: "INSERT INTO strategy_lap_metrics(session_id,driver_key,lap_id,algorithm_version,stint_id,payload) VALUES(?,?,?,?,?,?)",
      args: [input.sessionId,input.driverKey,input.lapId,input.algorithmVersion,input.stintId,JSON.stringify(input.contribution)],
    });
    if (estimate) await writePitEstimate(tx, estimate);
    const changes = summary.status === "active" ? [] : await strategyHistoryChanges(tx, [summary]);
    await tx.commit();
    publishStrategyChanges(changes);
    return true;
  } catch (error) { await tx.rollback(); throw error; }
  });
}
export async function saveStrategyStint(summary: StintSummary, totals: StrategyTotals): Promise<void> {
  return withDatabaseWrite(async () => {
  const tx = await client.transaction("write");
  try {
    await writeStint(tx, summary, totals);
    const changes = summary.status === "active" ? [] : await strategyHistoryChanges(tx, [summary]);
    await tx.commit();
    publishStrategyChanges(changes);
  } catch (error) { await tx.rollback(); throw error; }
  });
}
export async function closeStrategyStint(summary: StintSummary): Promise<void> {
  if (summary.status === "active") throw new Error("Cannot finalize an active strategy snapshot");
  return withDatabaseWrite(async () => {
  const tx = await client.transaction("write");
  try {
    await assertStrategyIdentity(tx, summary);
    await tx.execute({ sql: "UPDATE strategy_stints SET status=?,payload=?,revision=? WHERE id=?", args: [summary.status,JSON.stringify(summary),summary.revision,summary.id] });
    const changes = await strategyHistoryChanges(tx, [summary]);
    await tx.commit();
    publishStrategyChanges(changes);
  } catch (error) { await tx.rollback(); throw error; }
  });
}
export async function interruptActiveStrategyStints(): Promise<void> {
  return withDatabaseWrite(async () => {
  const tx = await client.transaction("write");
  try {
    const rows = await tx.execute("SELECT payload FROM strategy_stints WHERE status='active'");
    const scopes: StintSummary[] = [];
    for (const row of rows.rows) {
      const summary = StintSummarySchema.parse(JSON.parse(String(row.payload)));
      summary.status = "interrupted"; summary.endedAt = new Date().toISOString();
      summary.boundary = { reason: "process-restart", confidence: "unknown" }; summary.revision++;
      await tx.execute({ sql: "UPDATE strategy_stints SET status='interrupted',payload=?,revision=? WHERE id=?", args: [JSON.stringify(summary),summary.revision,summary.id] });
      scopes.push(summary);
    }
    const changes = await strategyHistoryChanges(tx, scopes);
    await tx.commit();
    publishStrategyChanges(changes);
  } catch (error) { await tx.rollback(); throw error; }
  });
}
export async function getStrategyHistoryRevision(gameId: GameId, driverKey: string): Promise<number> {
  const result = await client.execute({ sql: "SELECT revision FROM strategy_history_revisions WHERE game_id=? AND driver_key=?", args: [gameId,driverKey] });
  return Number(result.rows[0]?.revision ?? 0);
}
export async function strategySessionExists(sessionId: number, gameId: GameId): Promise<boolean> {
  const result = await client.execute({ sql: "SELECT 1 FROM sessions WHERE id=? AND game_id=?", args: [sessionId,gameId] });
  return result.rows.length === 1;
}

export async function getStrategyStints(sessionId: number, driverKey?: string): Promise<StintSummary[]> {
  const result = await client.execute({
    sql: `SELECT payload FROM strategy_stints WHERE session_id = ? ${driverKey == null ? "" : "AND driver_key = ?"}
      ORDER BY ordinal ASC, driver_key ASC, id ASC`,
    args: driverKey == null ? [sessionId] : [sessionId, driverKey],
  });
  return result.rows.map((row) => StintSummarySchema.parse(JSON.parse(String(row.payload))));
}

/** Durably allocate source order before asynchronous estimate derivation begins. */
export async function admitStrategyObservation(sessionId: number, sourceEpoch: string, sourceKey: string): Promise<SourceOrder> {
  if (sourceEpoch.length === 0 || sourceKey.length === 0) throw new Error("Strategy source epoch and key must be nonempty");
  const admissionKey = `${sourceEpoch}\0${sourceKey}`;
  return withDatabaseWrite(async () => {
    const tx = await client.transaction("write");
  try {
    const source = await tx.execute({ sql: "SELECT 1 FROM sessions WHERE id=?", args: [sessionId] });
    if (!source.rows.length) throw new StaleStrategyIdentityError("Strategy source session was removed");
    const admission = await tx.execute({
      sql: `SELECT epoch_ordinal, sequence FROM strategy_source_admissions WHERE session_id = ? AND source_key = ?`,
      args: [sessionId, admissionKey],
    });
    if (admission.rows[0]) {
      const order = { epochOrdinal: Number(admission.rows[0].epoch_ordinal), sequence: Number(admission.rows[0].sequence) };
      await tx.commit();
      return order;
    }
    const existing = await tx.execute({
      sql: `SELECT epoch_ordinal FROM strategy_source_epochs WHERE session_id = ? AND source_epoch = ?`,
      args: [sessionId, sourceEpoch],
    });
    let epochOrdinal: number;
    if (existing.rows[0]) {
      epochOrdinal = Number(existing.rows[0].epoch_ordinal);
    } else {
      const max = await tx.execute({ sql: `SELECT COALESCE(MAX(epoch_ordinal), -1) AS max_ordinal FROM strategy_source_epochs WHERE session_id = ?`, args: [sessionId] });
      epochOrdinal = Number(max.rows[0]?.max_ordinal ?? -1) + 1;
      await tx.execute({
        sql: `INSERT INTO strategy_source_epochs(session_id, source_epoch, epoch_ordinal) VALUES (?, ?, ?)`,
        args: [sessionId, sourceEpoch, epochOrdinal],
      });
    }
    const current = await tx.execute({
      sql: "SELECT COALESCE(MAX(sequence),-1) AS sequence FROM strategy_source_admissions WHERE session_id=? AND epoch_ordinal=?",
      args: [sessionId,epochOrdinal],
    });
    const sequence = Number(current.rows[0]?.sequence ?? -1) + 1;
    await tx.execute({
      sql: `INSERT INTO strategy_source_admissions(session_id, source_key, epoch_ordinal, sequence) VALUES (?, ?, ?, ?)`,
      args: [sessionId, admissionKey, epochOrdinal, sequence],
    });
    await tx.execute({
      sql: `INSERT INTO strategy_session_state(session_id, high_water_epoch, high_water_sequence) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
        high_water_epoch=max(high_water_epoch,excluded.high_water_epoch),
        high_water_sequence=CASE WHEN excluded.high_water_epoch > high_water_epoch THEN excluded.high_water_sequence
          WHEN excluded.high_water_epoch = high_water_epoch THEN max(high_water_sequence,excluded.high_water_sequence)
          ELSE high_water_sequence END`,
      args: [sessionId, epochOrdinal, sequence],
    });
    await tx.commit();
    return { epochOrdinal, sequence };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  });
}
async function writePitEstimate(tx: Transaction, record: PitEstimateRecord): Promise<boolean> {
  await assertStrategyIdentity(tx, record);
  const state = await tx.execute({ sql: "SELECT clear_epoch,clear_sequence FROM strategy_driver_state WHERE session_id=? AND driver_key=?", args: [record.sessionId,record.driverKey] });
  const watermark = state.rows[0];
  if (watermark && (record.sourceOrder.epochOrdinal < Number(watermark.clear_epoch) ||
    record.sourceOrder.epochOrdinal === Number(watermark.clear_epoch) && record.sourceOrder.sequence <= Number(watermark.clear_sequence))) return false;
  const result = await tx.execute({
    sql: "INSERT OR IGNORE INTO pit_estimates(id,session_id,driver_key,stint_id,epoch_ordinal,sequence,payload) VALUES(?,?,?,?,?,?,?)",
    args: [record.id,record.sessionId,record.driverKey,record.stintId,record.sourceOrder.epochOrdinal,record.sourceOrder.sequence,JSON.stringify(record)],
  });
  return result.rowsAffected > 0;
}
export async function savePitEstimate(record: PitEstimateRecord): Promise<boolean> {
  return withDatabaseWrite(async () => {
  const tx = await client.transaction("write");
  try {
    const inserted = await writePitEstimate(tx, record);
    await tx.commit();
    return inserted;
  } catch (error) { await tx.rollback(); throw error; }
  });
}

export async function clearPitEstimates(sessionId: number, driverKey?: string): Promise<number> {
  return withDatabaseWrite(async () => {
    const tx = await client.transaction("write");
  try {
    const current = await tx.execute({ sql: `SELECT high_water_epoch, high_water_sequence FROM strategy_session_state WHERE session_id = ?`, args: [sessionId] });
    const state = current.rows[0];
    const epoch = Number(state?.high_water_epoch ?? 0);
    const sequence = Number(state?.high_water_sequence ?? -1);
    const drivers = driverKey == null
      ? await tx.execute({ sql: `SELECT DISTINCT driver_key FROM pit_estimates WHERE session_id = ? UNION SELECT driver_key FROM strategy_driver_state WHERE session_id = ?`, args: [sessionId, sessionId] })
      : { rows: [{ driver_key: driverKey }] };
    let deletedCount = 0;
    for (const row of drivers.rows) {
      const key = String(row.driver_key);
      await tx.execute({
        sql: `INSERT INTO strategy_driver_state(session_id, driver_key, clear_epoch, clear_sequence, clear_generation)
          VALUES (?, ?, ?, ?, 1) ON CONFLICT(session_id, driver_key) DO UPDATE SET
          clear_epoch=excluded.clear_epoch, clear_sequence=excluded.clear_sequence, clear_generation=clear_generation+1`,
        args: [sessionId, key, epoch, sequence],
      });
      const deleted = await tx.execute({ sql: `DELETE FROM pit_estimates WHERE session_id = ? AND driver_key = ?`, args: [sessionId, key] });
      deletedCount += Number(deleted.rowsAffected ?? 0);
    }
    await tx.commit();
    return deletedCount;
  } catch (error) { await tx.rollback(); throw error; }
  });
}

export class InvalidStrategyCursorError extends Error {}

interface EstimateCursor {
  sessionId: number;
  gameId: string;
  driverKey: string | null;
  generation: string;
  epochOrdinal: number;
  sequence: number;
  id: string;
}

const EstimateCursorSchema = z.object({
  sessionId: z.number().int().positive(),
  gameId: z.string().min(1),
  driverKey: z.string().nullable(),
  generation: z.string(),
  epochOrdinal: z.number().int().nonnegative().safe(),
  sequence: z.number().int().nonnegative().safe(),
  id: z.string(),
}).strict();

export async function getPitEstimatePage(sessionId: number, gameId: string, driverKey: string | undefined, limit: number, before?: string): Promise<{ estimates: PitEstimateRecord[]; nextCursor: string | null }> {
  const tx = await client.transaction("read");
  try {
    const filterKey = driverKey ?? null;
    const state = await tx.execute({
      sql: `SELECT driver_key, clear_generation FROM strategy_driver_state WHERE session_id = ? AND clear_generation > 0 ${driverKey == null ? "" : "AND driver_key = ?"} ORDER BY driver_key`,
      args: driverKey == null ? [sessionId] : [sessionId, driverKey],
    });
    const generation = JSON.stringify(state.rows.map((row) => [String(row.driver_key), Number(row.clear_generation)]));
    let cursor: EstimateCursor | undefined;
    if (before != null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(before, "base64url").toString("utf8"));
      } catch {
        throw new InvalidStrategyCursorError();
      }
      const parsed = EstimateCursorSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.gameId !== gameId ||
        parsed.data.driverKey !== filterKey || parsed.data.generation !== generation) {
        throw new InvalidStrategyCursorError();
      }
      cursor = parsed.data;
    }
    const where = `session_id = ? ${driverKey == null ? "" : "AND driver_key = ?"} ${cursor ? "AND (epoch_ordinal, sequence, id) < (?, ?, ?)" : ""}`;
    const args: (string | number)[] = driverKey == null ? [sessionId] : [sessionId, driverKey];
    if (cursor) args.push(cursor.epochOrdinal, cursor.sequence, cursor.id);
    args.push(limit + 1);
    const result = await tx.execute({
      sql: `SELECT id, epoch_ordinal, sequence, payload FROM pit_estimates WHERE ${where}
        ORDER BY epoch_ordinal DESC, sequence DESC, id DESC LIMIT ?`,
      args,
    });
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const estimates = rows.map((row) => PitEstimateRecordSchema.parse(JSON.parse(String(row.payload))));
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
      sessionId, gameId, driverKey: filterKey, generation, epochOrdinal: Number(last.epoch_ordinal),
      sequence: Number(last.sequence), id: String(last.id),
    })).toString("base64url") : null;
    await tx.commit();
    return { estimates, nextCursor };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
export async function activateStrategyRebuild(
  sessionId: number,
  expected: { gameId: GameId; carId: string; trackId: string; ownership: string },
  generation: string,
  staged: readonly { summary: StintSummary; totals: StrategyTotals }[],
  contributions: readonly PersistStrategyLapInput[],
  transaction?: Transaction,
): Promise<StrategyHistoryUpdatedMessage[]> {
  for (const entry of staged) StintSummarySchema.parse(entry.summary);
  const tx = transaction ?? await client.transaction("write");
  try {
    const current = await tx.execute({ sql: "SELECT game_id,car_id,track_id,ownership FROM sessions WHERE id=?", args: [sessionId] });
    const session = current.rows[0];
    if (!session || session.game_id !== expected.gameId || session.car_id !== expected.carId ||
      session.track_id !== expected.trackId || session.ownership !== expected.ownership) throw new Error("Strategy rebuild source identity changed");
    const old = await tx.execute({ sql: "SELECT DISTINCT json_extract(payload,'$.gameId') AS game_id,driver_key FROM strategy_stints WHERE session_id=?", args: [sessionId] });
    const scopes = old.rows.map((row) => ({ gameId: String(row.game_id), driverKey: String(row.driver_key) }));
    await tx.execute({ sql: "DELETE FROM strategy_stints WHERE session_id=?", args: [sessionId] });
    for (const entry of staged) {
      if (entry.summary.sessionId !== sessionId) throw new Error("Strategy rebuild contains another session");
      await writeStint(tx, entry.summary, entry.totals);
      scopes.push(entry.summary);
    }
    for (const entry of contributions) {
      if (entry.sessionId !== sessionId) throw new Error("Strategy contribution contains another session");
      const result = await tx.execute({
        sql: `INSERT INTO strategy_lap_metrics(session_id,driver_key,lap_id,algorithm_version,stint_id,payload)
          SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM laps WHERE id=? AND session_id=?)`,
        args: [sessionId,entry.driverKey,entry.lapId,entry.algorithmVersion,entry.stintId,JSON.stringify(entry.contribution),entry.lapId,sessionId],
      });
      if (result.rowsAffected !== 1) throw new Error("Strategy rebuild lap identity changed");
    }
    await tx.execute({ sql: `INSERT INTO strategy_session_state(session_id,rebuild_generation) VALUES(?,?)
      ON CONFLICT(session_id) DO UPDATE SET rebuild_generation=excluded.rebuild_generation`, args: [sessionId,generation] });
    const changes = await strategyHistoryChanges(tx, scopes);
    if (!transaction) {
      await tx.commit();
      publishStrategyChanges(changes);
    }
    return changes;
  } catch (error) {
    if (!transaction) await tx.rollback();
    throw error;
  }
}
