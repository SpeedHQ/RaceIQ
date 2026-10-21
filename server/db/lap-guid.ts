import type { Client, Transaction } from "@libsql/client/sqlite3";

/** UUIDv7: Unix milliseconds in the high 48 bits, cryptographic random remainder. */
export function createLapGuid(): string {
  return Bun.randomUUIDv7();
}

/** Backfill maps without inventing identity for legacy or imported laps. */
export async function backfillLapGuids(client: Client): Promise<void> {
  const pending = await client.execute(`SELECT l.id, l.lap_guid, s.cloud_import_origin, s.cloud_import_lap_id
    FROM laps l JOIN sessions s ON s.id=l.session_id
    LEFT JOIN lap_guid_reconciliation r ON r.lap_id=l.id
    WHERE r.lap_id IS NULL ORDER BY l.id`);
  if (!pending.rows.length) return;
  const tx = await client.transaction("write");
  try {
    for (const row of pending.rows) {
      const lapId = Number(row.id);
      const guid = row.lap_guid == null ? null : String(row.lap_guid).toLowerCase();
      await tx.execute({
        sql: "INSERT INTO lap_guid_reconciliation(lap_id,lap_guid,source_guid,status) VALUES (?,?,NULL,?)",
        args: [lapId, guid, "held_ambiguous"],
      });
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/** Bind an imported row to its authoritative original identity within caller's transaction. */
export async function bindAuthoritativeLapGuidInTransaction(tx: Transaction, lapId: number, sourceGuid: string): Promise<void> {
  const guid = sourceGuid.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(guid)) {
    throw new Error("Authoritative lap GUID is not canonical UUID");
  }
  const lap = await tx.execute({ sql: "SELECT lap_guid FROM laps WHERE id=?", args: [lapId] });
  if (!lap.rows.length) throw new Error("Lap row is missing");
  const duplicate = await tx.execute({
    sql: "SELECT id FROM laps WHERE lower(lap_guid)=? AND id<>? UNION SELECT lap_id AS id FROM lap_guid_reconciliation WHERE lower(lap_guid)=? AND lap_id<>?",
    args: [guid, lapId, guid, lapId],
  });
  if (duplicate.rows.length) throw new Error("Lap GUID identity conflicts with another original lap");
  const row = await tx.execute({ sql: "SELECT lap_guid,source_guid FROM lap_guid_reconciliation WHERE lap_id=?", args: [lapId] });
  const current = row.rows[0];
  if (current?.source_guid != null && String(current.source_guid).toLowerCase() !== guid) {
    throw new Error("Lap GUID provenance conflicts with existing source identity");
  }
  const existingGuid = current?.lap_guid ?? lap.rows[0]!.lap_guid;
  if (existingGuid != null && String(existingGuid).toLowerCase() !== guid) {
    throw new Error("Lap GUID identity conflicts with existing original identity");
  }
  await tx.execute({ sql: "UPDATE laps SET lap_guid=? WHERE id=?", args: [guid, lapId] });
  await tx.execute({
    sql: `INSERT INTO lap_guid_reconciliation(lap_id,lap_guid,source_guid,status) VALUES (?,?,?,'resolved')
      ON CONFLICT(lap_id) DO UPDATE SET lap_guid=excluded.lap_guid,source_guid=excluded.source_guid,status='resolved'`,
    args: [lapId, guid, guid],
  });
}

/** Bind a downloaded representation to a service-authoritative original GUID. */
export async function bindAuthoritativeLapGuid(client: Client, lapId: number, sourceGuid: string): Promise<void> {
  const tx = await client.transaction("write");
  try {
    await bindAuthoritativeLapGuidInTransaction(tx, lapId, sourceGuid);
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
