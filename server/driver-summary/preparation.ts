import { client, readClient } from "../db/index";
import { withDatabaseWrite } from "../db/write-coordination";

export const DRIVER_SUMMARY_PREPARATION_BATCH = 64;
export interface DriverSummaryPreparationGeneration { activityId: string; generation: number }
export interface DriverSummaryPreparationSnapshot {
  schemaVersion: 1;
  contentHash: string | null;
  heldLaps: number;
  payload: unknown;
}

export function parseDriverSummaryPreparationSnapshot(value: unknown): DriverSummaryPreparationSnapshot | null {
  if (typeof value !== "string") return null;
  try {
    const row: unknown = JSON.parse(value);
    if (!row || typeof row !== "object") return null;
    const snapshot = row as Record<string, unknown>;
    if (snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.heldLaps) || Number(snapshot.heldLaps) < 0
      || (snapshot.contentHash !== null && (typeof snapshot.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(snapshot.contentHash)))) return null;
    return { schemaVersion: 1, contentHash: snapshot.contentHash as string | null,
      heldLaps: Number(snapshot.heldLaps), payload: snapshot.payload };
  } catch { return null; }
}

export async function readDirtyDriverSummaryPreparations(): Promise<DriverSummaryPreparationGeneration[]> {
  const result = await readClient.execute({ sql: `SELECT original_activity_id,generation FROM original_activity_preparations
    WHERE prepared_generation IS NULL OR generation<>prepared_generation ORDER BY original_activity_id LIMIT ?`, args: [DRIVER_SUMMARY_PREPARATION_BATCH] });
  return result.rows.map((row) => ({ activityId: String(row.original_activity_id), generation: Number(row.generation) }));
}

export async function hasPendingDriverSummaryPreparations(): Promise<boolean> {
  const result = await readClient.execute(`SELECT EXISTS(SELECT 1 FROM original_activity_preparations WHERE prepared_generation IS NULL OR generation<>prepared_generation) pending`);
  return Number(result.rows[0]?.pending) === 1;
}

/** Holds never destroy the last usable aggregate snapshot; deletion never emits a cloud tombstone. */
export async function settleDriverSummaryPreparation(
  source: DriverSummaryPreparationGeneration, snapshot: DriverSummaryPreparationSnapshot, holdReason: string | null,
): Promise<boolean> {
  const json = JSON.stringify(snapshot);
  const result = await withDatabaseWrite(() => client.execute({ sql: `UPDATE original_activity_preparations SET prepared_generation=?,
      snapshot_json=CASE WHEN ? IS NULL THEN ? ELSE COALESCE(snapshot_json,?) END,hold_reason=?,held_laps=?
    WHERE original_activity_id=? AND generation=?`,
    args: [source.generation, holdReason, json, json, holdReason, snapshot.heldLaps, source.activityId, source.generation] }));
  return result.rowsAffected === 1;
}

/** Final worker transport guard; a wake hint or cached ready ledger alone is not current source proof. */
export async function isDriverSummaryContributionCurrent(activityId: string, contentHash: string): Promise<boolean> {
  const result = await readClient.execute({ sql: `SELECT snapshot_json FROM original_activity_preparations
    WHERE original_activity_id=? AND generation=prepared_generation AND hold_reason IS NULL`, args: [activityId] });
  return parseDriverSummaryPreparationSnapshot(result.rows[0]?.snapshot_json)?.contentHash === contentHash;
}
