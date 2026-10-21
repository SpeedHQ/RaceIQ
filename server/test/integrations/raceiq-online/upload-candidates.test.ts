import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameId } from "@raceiq/shared/games/ids";
import { client, db } from "../../../db";
import { deleteSession, insertSession, updateSessionRawFile, updateSessionSource } from "../../../db/session-queries";
import { claimLocalAccountOwner, getLocalAccountOwner,getLocalGameBindingSnapshot,upsertLocalGameBinding } from "../../../db/local-account-queries";
import { insertLap } from "../../../db/lap-mutation-queries";
import { laps, sessions } from "../../../db/schema";
import { replaceLapsForSession } from "../../../db/lap-reprocessing-queries";
import { bindAuthoritativeLapGuidInTransaction, backfillLapGuids } from "../../../db/lap-guid";
import { setLapDriverAttribution } from "../../../db/driver-summary-ledger-queries";
import { eq } from "drizzle-orm";
import { getOnlineUploadCandidatePage,type OnlineUploadCandidate,type OnlineUploadCandidateCursor } from "../../../db/online-upload-queries";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";

async function addLap(input: {
  gameId?: string;
  trackId: string;
  carId: string;
  lapTime: number;
  ownership?: "mine" | "others";
  source?: string;
  sectors?: number[] | null;
  valid?: boolean;
  attribution?:"Self"|"Other"|"Unknown";
}) {
  const gameId=(input.gameId??"acc") as GameId;
  const sessionId = await insertSession(input.carId,input.trackId,gameId,undefined,undefined,input.ownership,input.source?undefined:{kind:"native_capture"});
  await updateSessionRawFile(sessionId, "/fixture/local-session.bin", "fixture-detector");
  if (input.source) await updateSessionSource(sessionId, input.source);
  const sectors = input.sectors === undefined ? [input.lapTime / 3, input.lapTime / 3, input.lapTime / 3] : input.sectors;
  const lapId = await insertLap(sessionId, 1, input.lapTime, input.valid ?? true, 0, 10, null, null, null, sectors);
  const existing=(await getLocalGameBindingSnapshot()).bindings.find(binding=>binding.gameId===gameId);
  const binding=existing??{id:`candidate-fixture-${gameId}`,gameId,sourceKind:`${gameId}-fixture`,nativeIdentity:JSON.stringify({schemaVersion:1,actorId:"fixture-driver",bindingScope:"installation"}),confirmation:"user_confirmed" as const,revision:1};
  if(!existing)await upsertLocalGameBinding(binding);
  const descriptor=JSON.parse(binding.nativeIdentity) as {actorId:string};
  const stint:DriverAttributionStint={gameId,source:binding.sourceKind,sessionId:String(sessionId),clockDomain:"fixture-clock",startMs:0,endMs:10_000,evidenceValidUntilMs:10_000,
    actor:{gameId,source:binding.sourceKind,actorId:descriptor.actorId,bindingScope:"installation",sessionId:String(sessionId),clockDomain:"fixture-clock",observedAtMs:0},
    bindingRevision:binding.revision,bindingSnapshot:{...binding,gameId},attribution:input.attribution??"Self"};
  await setLapDriverAttribution(lapId,[stint],input.attribution??"Self",{domain:"fixture-clock",startMs:0,endMs:10_000});
  return { sessionId, lapId };
}

test("cancelled first owner claim rolls back actual history writes before commit in an isolated database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-claim-rollback-"));
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/claim-owner.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    env: { ...process.env, DATA_DIR: directory, RACEIQ_TEST_MODE: "1", DB_IN_MEMORY: "0" },
    stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(25_000),
  });
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native capture snapshots installation owner and persists lap identity", async () => {
  await claimLocalAccountOwner("owner-a");
  const sessionId = await insertSession("owner-car", "owner-track", "iracing" as GameId, undefined, undefined, undefined, { kind: "native_capture" });
  try {
    const session = await db.select({
      ownerUserId: sessions.ownerUserId,
      originalActivityId: sessions.originalActivityId,
      nativeCaptureOrigin: sessions.nativeCaptureOrigin,
    }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(session).toMatchObject({
      ownerUserId: "owner-a",
      nativeCaptureOrigin: true,
    });
    expect(session?.originalActivityId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(db.update(sessions).set({ originalActivityId: "018f0f8a-7b21-7cc2-9f3a-5c7d09a681ab" })
      .where(eq(sessions.id, sessionId)).run()).rejects.toThrow();
    expect((await db.select({ originalActivityId: sessions.originalActivityId }).from(sessions)
      .where(eq(sessions.id, sessionId)).get())?.originalActivityId).toBe(session?.originalActivityId);
    const lapId = await insertLap(sessionId, 1, 73.125, false, null, 0);
    const lap = await db.select({ lapGuid: laps.lapGuid }).from(laps).where(eq(laps.id, lapId)).get();
    const replacement = {
      lapId,
      lapNumber: 1,
      lapTime: 73.125,
      isValid: false,
      classification: null,
      isFavorite: false,
      rawByteOffset: null,
      rawFrameCount: 0,
      tuneId: null,
      notes: null,
      invalidReason: null,
      sectors: null,
    };
    await replaceLapsForSession(sessionId, [replacement]);
    const stableGuid = await db.select({ lapGuid: laps.lapGuid })
      .from(laps).where(eq(laps.id, lapId)).get();
    expect(stableGuid?.lapGuid).toBe(lap?.lapGuid);
    await replaceLapsForSession(sessionId, [{ ...replacement, lapNumber: 2 }]);
    const resegmented = await client.execute({
      sql: "SELECT lap_guid,status FROM lap_guid_reconciliation WHERE lap_id=?",
      args: [lapId],
    });
    expect(resegmented.rows[0]).toMatchObject({ lap_guid: lap?.lapGuid, status: "held_ambiguous" });
    expect(lap?.lapGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await client.execute({ sql: "DELETE FROM lap_guid_reconciliation WHERE lap_id=?", args: [lapId] });
    await backfillLapGuids(client);
    const restored = await client.execute({
      sql: "SELECT l.lap_guid, r.status FROM laps l JOIN lap_guid_reconciliation r ON r.lap_id=l.id WHERE l.id=?",
      args: [lapId],
    });
    expect(restored.rows[0]).toMatchObject({ lap_guid: lap?.lapGuid, status: "held_ambiguous" });
    await setLapDriverAttribution(lapId, [], "Unknown", {
      domain: "fixture", startMs: 12.375, endMs: 24.625,
    });
    const fractional = await db.select({ start: laps.sourceLapStartMs, end: laps.sourceLapEndMs })
      .from(laps).where(eq(laps.id, lapId)).get();
    expect(fractional).toEqual({ start: 12.375, end: 24.625 });
    const borrowedId = await insertSession("borrowed-car", "owner-track", "iracing" as GameId, undefined, undefined, "others", {
      kind: "portable_import",
      originalActivityId: "source-activity-a",
    });
    try {
      const borrowedSession = await db.select({
        originalActivityId: sessions.originalActivityId,
        nativeCaptureOrigin: sessions.nativeCaptureOrigin,
      }).from(sessions).where(eq(sessions.id, borrowedId)).get();
      expect(borrowedSession).toEqual({ originalActivityId: "source-activity-a", nativeCaptureOrigin: false });
      const importedLapId = await insertLap(borrowedId, 1, 71.5, true, null, 0);
      const importedGuid = "018f0f8a-7b21-7cc2-9f3a-5c7d09a681ab";
      const tx = await client.transaction("write");
      try {
        await bindAuthoritativeLapGuidInTransaction(tx, importedLapId, importedGuid);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      const bound = await db.select({ lapGuid: laps.lapGuid }).from(laps).where(eq(laps.id, importedLapId)).get();
      expect(bound?.lapGuid).toBe(importedGuid);
      const duplicateId = await insertSession("borrowed-car-2", "owner-track", "iracing" as GameId, undefined, undefined, "others");
      try {
        const duplicateLapId = await insertLap(duplicateId, 1, 71.75, true, null, 0);
        const conflict = await client.transaction("write");
        try {
          await expect(bindAuthoritativeLapGuidInTransaction(conflict, duplicateLapId, importedGuid))
            .rejects.toThrow("Lap GUID identity conflicts with another original lap");
        } finally {
          await conflict.rollback();
        }
      } finally {
        await deleteSession(duplicateId);
      }
    } finally {
      await deleteSession(borrowedId);
    }
    await claimLocalAccountOwner("owner-a");
    expect(await getLocalAccountOwner()).toBe("owner-a");
    await expect(claimLocalAccountOwner("owner-b")).rejects.toMatchObject({ code: "account_conflict" });
  } finally {
    await deleteSession(sessionId);
  }
});

test("online candidate pages retain ordered proven laps for preparation fallback without promoting Other or Unknown",async()=>{
  const created: number[] = [];
  try {
    await claimLocalAccountOwner(await getLocalAccountOwner()??"owner-a");
    const slower = await addLap({ trackId: "upload-fixture-track", carId: "car-slower", lapTime: 100 });
    created.push(slower.sessionId);
    const fastestSlowCar = await addLap({ trackId: "upload-fixture-track", carId: "car-slower", lapTime: 95 });
    created.push(fastestSlowCar.sessionId);
    const fastestOtherCar = await addLap({ trackId: "upload-fixture-track", carId: "car-fastest", lapTime: 90 });
    created.push(fastestOtherCar.sessionId);
    const unknownFaster=await addLap({trackId:"upload-fixture-track",carId:"car-fastest",lapTime:75,attribution:"Unknown"});
    const otherFaster=await addLap({trackId:"upload-fixture-track",carId:"car-fastest",lapTime:76,attribution:"Other"});
    created.push(unknownFaster.sessionId,otherFaster.sessionId);
    const otherGame = await addLap({ gameId: "iracing", trackId: "upload-fixture-track", carId: "car-iracing", lapTime: 80 });
    created.push(otherGame.sessionId);
    const thirdParty = await addLap({ trackId: "upload-fixture-third-party", carId: "car-third-party", lapTime: 70, ownership: "others" });
    created.push(thirdParty.sessionId);
    const motec = await addLap({ trackId: "upload-fixture-motec", carId: "car-motec", lapTime: 60, source: "motec" });
    created.push(motec.sessionId);
    const cloudImport = await addLap({ trackId: "upload-fixture-cloud", carId: "car-cloud", lapTime: 55, source: "cloud-import" });
    created.push(cloudImport.sessionId);
    const missingSectors = await addLap({ trackId: "upload-fixture-no-sectors", carId: "car-no-sectors", lapTime: 54, sectors: null });
    created.push(missingSectors.sessionId);
    const invalidSector = await addLap({ trackId: "upload-fixture-invalid-sector", carId: "car-invalid-sector", lapTime: 53, sectors: [20, 0, 30] });
    created.push(invalidSector.sessionId);
    const invalidLap = await addLap({ trackId: "upload-fixture-invalid-lap", carId: "car-invalid-lap", lapTime: 52, valid: false });
    created.push(invalidLap.sessionId);
    const unsupportedGame = await addLap({ gameId: "unsupported-game", trackId: "upload-fixture-unsupported", carId: "car-unsupported", lapTime: 51 });
    created.push(unsupportedGame.sessionId);
    const f1World = await addLap({ gameId: "f1-2025", trackId: "upload-fixture-f1", carId: "41", lapTime: 90 });
    created.push(f1World.sessionId);
    const f1OtherCar = await addLap({ gameId: "f1-2025", trackId: "upload-fixture-f1-other", carId: "44", lapTime: 70 });
    created.push(f1OtherCar.sessionId);

    const rows: OnlineUploadCandidate[] = [];
    let cursor:OnlineUploadCandidateCursor|null=null;
    for(;;){
      const page=await getOnlineUploadCandidatePage(cursor);
      rows.push(...page.items);
      if(!page.nextCursor)break;
      cursor=page.nextCursor;
    }
    expect(rows).toContainEqual(expect.objectContaining({ lapId: fastestOtherCar.lapId, gameId: "acc", trackId: "upload-fixture-track", carId: "car-fastest", valid: true }));
    expect(rows).toContainEqual(expect.objectContaining({ lapId: fastestSlowCar.lapId, gameId: "acc", trackId: "upload-fixture-track", carId: "car-slower", valid: true }));
    expect(rows).toContainEqual(expect.objectContaining({ lapId: otherGame.lapId, gameId: "iracing", trackId: "upload-fixture-track" }));
    expect(rows.some((row) => row.lapId === f1World.lapId)).toBe(true);
    expect(rows.some((row)=>row.lapId===f1OtherCar.lapId)).toBe(false);
    expect(rows.findIndex(row=>row.lapId===fastestSlowCar.lapId)).toBeLessThan(rows.findIndex(row=>row.lapId===slower.lapId));
    expect(rows.some(row=>row.lapId===unknownFaster.lapId||row.lapId===otherFaster.lapId)).toBe(false);
    expect(rows.some((row) => row.lapId === thirdParty.lapId || row.lapId === motec.lapId)).toBe(false);
    expect(rows.some((row) => [cloudImport, missingSectors, invalidSector, invalidLap, unsupportedGame].some(({ lapId }) => row.lapId === lapId))).toBe(false);
    const afterFastest=await getOnlineUploadCandidatePage({gameId:"acc",trackId:"upload-fixture-track",carId:"car-slower",lapTimeMs:95_000,lapId:fastestSlowCar.lapId});
    expect(afterFastest.items[0]?.lapId).toBe(slower.lapId);
  } finally {
    for (const sessionId of created) await deleteSession(sessionId);
  }
});
