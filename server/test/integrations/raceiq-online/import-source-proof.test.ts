import { expect, test } from "bun:test";
import { client } from "../../../db";
import { bindAuthoritativeLapGuid } from "../../../db/lap-guid";
import { getLocalAccountOwner, claimLocalAccountOwner } from "../../../db/local-account-queries";
import { insertLap } from "../../../db/lap-mutation-queries";
import {
  closeNativeOriginalActivitySource, finalizeNativeOriginalActivitySource,
  readOriginalActivitySourceProof, retainOriginalLapIdentityInTransaction,
} from "../../../db/original-activity-queries";
import { deleteSession, insertSession } from "../../../db/session-queries";

async function ensureOwner(): Promise<string> {
  const existing = await getLocalAccountOwner();
  if (existing) return existing;
  const id = `source-proof-owner-${crypto.randomUUID()}`;
  await claimLocalAccountOwner(id);
  const owner = await getLocalAccountOwner();
  if (!owner) throw new Error("Missing local account owner for source proof fixture");
  return owner;
}

async function nativeSession() {
  await ensureOwner();
  const sessionId = await insertSession("source-proof-car", "source-proof-track", "acc", "race", undefined, "mine", { kind: "native_capture" });
  const row = await client.execute({ sql: "SELECT original_activity_id,owner_user_id FROM sessions WHERE id=?", args: [sessionId] });
  return { sessionId, activityId: String(row.rows[0]!.original_activity_id), ownerUserId: String(row.rows[0]!.owner_user_id) };
}

async function addResolvedLap(sessionId: number, lapNumber: number) {
  const lapId = await insertLap(sessionId, lapNumber, 60 + lapNumber, true, lapNumber * 10, 1);
  const row = await client.execute({ sql: "SELECT lap_guid FROM laps WHERE id=?", args: [lapId] });
  const lapGuid = String(row.rows[0]!.lap_guid);
  await client.execute({ sql: "UPDATE laps SET source_clock_domain=?,source_lap_start_ms=?,source_lap_end_ms=? WHERE id=?",
    args: [`source-proof-${sessionId}`, lapNumber * 60_000, (lapNumber + 1) * 60_000, lapId] });
  return { lapId, lapGuid };
}

async function cleanup(sessionId: number, activityId: string, lapGuids: string[]) {
  await deleteSession(sessionId);
  for (const lapGuid of lapGuids) {
    await client.execute({ sql: "DELETE FROM original_activity_source_laps WHERE lap_guid=?", args: [lapGuid] });
  }
  await client.execute({ sql: "DELETE FROM original_activity_sources WHERE original_activity_id=?", args: [activityId] });
}


test("conflicting imported lap GUID or owner identity is rejected without changing retained originals", async () => {
  const { sessionId, activityId, ownerUserId } = await nativeSession();
  const first = await addResolvedLap(sessionId, 1);
  const second = await addResolvedLap(sessionId, 2);
  const firstGuid = first.lapGuid;
  const secondGuid = second.lapGuid;
  try {
    const retain = await client.transaction("write");
    await retainOriginalLapIdentityInTransaction(retain, firstGuid, activityId, ownerUserId, "revision-1");
    await retain.commit();

    await expect(bindAuthoritativeLapGuid(client, second.lapId, firstGuid)).rejects.toThrow("Lap GUID identity conflicts with another original lap");
    const laps = await client.execute({ sql: "SELECT id,lap_guid FROM laps WHERE id IN (?,?) ORDER BY id", args: [first.lapId, second.lapId] });
    expect(laps.rows.map((row) => row.lap_guid)).toEqual([firstGuid, secondGuid]);
    const reconciliation = await client.execute({ sql: "SELECT lap_id,lap_guid,source_guid,status FROM lap_guid_reconciliation WHERE lap_id IN (?,?) ORDER BY lap_id", args: [first.lapId, second.lapId] });
    expect(reconciliation.rows.map((row) => ({
      lap_id: row.lap_id, lap_guid: row.lap_guid, source_guid: row.source_guid, status: row.status,
    }))).toEqual([
      { lap_id: first.lapId, lap_guid: firstGuid, source_guid: null, status: "resolved" },
      { lap_id: second.lapId, lap_guid: secondGuid, source_guid: null, status: "resolved" },
    ]);

    const tx = await client.transaction("write");
    await expect((async () => {
      try {
        await retainOriginalLapIdentityInTransaction(tx, firstGuid, activityId, "different-owner", "revision-1");
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    })()).rejects.toThrow("Original lap belongs to another source or owner");
    const retained = await client.execute({ sql: "SELECT original_activity_id,owner_user_id,source_revision FROM original_activity_source_laps WHERE lap_guid=?", args: [firstGuid] });
    expect(retained.rows[0]).toMatchObject({ original_activity_id: activityId, owner_user_id: ownerUserId, source_revision: "revision-1" });
  } finally {
    await cleanup(sessionId, activityId, [firstGuid, secondGuid]);
  }
});

test("native closure proves full resolved original membership and preserves owner identity", async () => {
  const { sessionId, activityId, ownerUserId } = await nativeSession();
  const lapGuids: string[] = [];
  try {
    lapGuids.push((await addResolvedLap(sessionId, 1)).lapGuid);
    lapGuids.push((await addResolvedLap(sessionId, 2)).lapGuid);
    await closeNativeOriginalActivitySource(sessionId, { sourceRevision: "closed-revision", lapCount: 2, gapCount: 0 });
    await finalizeNativeOriginalActivitySource(sessionId);

    expect(await readOriginalActivitySourceProof(sessionId)).toEqual({
      schemaVersion: 1, originalActivityId: activityId, sourceRevision: "closed-revision",
      originalLapGuids: [...lapGuids].sort(), coverage: "complete", origin: "native_capture", ownerUserId,
    });
  } finally {
    await cleanup(sessionId, activityId, lapGuids);
  }
});

test("missing, unresolved, or gapped native evidence never fabricates complete proof", async () => {
  const cases = [
    { name: "missing closure", close: false, unresolved: false, gapCount: 0 },
    { name: "unresolved membership", close: true, unresolved: true, gapCount: 0 },
    { name: "reported source gap", close: true, unresolved: false, gapCount: 1 },
  ] as const;
  for (const [index, scenario] of cases.entries()) {
    const { sessionId, activityId } = await nativeSession();
    const lapGuids: string[] = [];
    try {
      const lap = await addResolvedLap(sessionId, 1);
      lapGuids.push(lap.lapGuid);
      if (scenario.unresolved) {
        await client.execute({ sql: "UPDATE lap_guid_reconciliation SET status='held_ambiguous' WHERE lap_id=?", args: [lap.lapId] });
      }
      if (scenario.close) await closeNativeOriginalActivitySource(sessionId, {
        sourceRevision: `incomplete-revision-${index}`, lapCount: 1, gapCount: scenario.gapCount,
      });
      await finalizeNativeOriginalActivitySource(sessionId);
      expect(await readOriginalActivitySourceProof(sessionId), scenario.name).toBeNull();
    } finally {
      await cleanup(sessionId, activityId, lapGuids);
    }
  }
});
