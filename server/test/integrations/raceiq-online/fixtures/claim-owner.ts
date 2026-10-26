import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { client, db, initDb } from "../../../../db";
import { claimLocalAccountOwner, getLocalAccountOwner } from "../../../../db/local-account-queries";
import { deleteSession, insertSession } from "../../../../db/session-queries";
import { insertLap } from "../../../../db/lap-mutation-queries";
import { bindAuthoritativeLapGuid } from "../../../../db/lap-guid";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { setLapDriverAttribution } from "../../../../db/driver-summary-ledger-queries";
import { laps, sessions } from "../../../../db/schema";

await initDb();
try {
  assert.equal(await getLocalAccountOwner(), null);
  const native = await insertSession("claim-car", "claim-track", "iracing", undefined, undefined, "mine", { kind: "native_capture" });
  const borrowedSource = await insertSession("borrowed-car", "claim-track", "iracing", undefined, undefined, "mine", { kind: "native_capture" });
  const borrowedSourceLap = await insertLap(borrowedSource, 1, 89, true, null, 0);
  const sourceIdentity = await db.select({ activityId: sessions.originalActivityId, guid: laps.lapGuid })
    .from(sessions).innerJoin(laps, eq(laps.sessionId, sessions.id)).where(eq(laps.id, borrowedSourceLap)).get();
  assert.ok(sourceIdentity?.activityId && sourceIdentity.guid);
  await deleteSession(borrowedSource);
  const borrowed = await insertSession("borrowed-car", "claim-track", "iracing", undefined, undefined, "others", {
    kind: "portable_import", originalActivityId: sourceIdentity.activityId,
  });
  const nativeLap = await insertLap(native, 1, 90, true, null, 0);
  const borrowedLap = await insertLap(borrowed, 1, 89, true, null, 0);
  await bindAuthoritativeLapGuid(client, borrowedLap, sourceIdentity.guid);
  const binding = {
    id: "claim-binding", gameId: "iracing" as const, sourceKind: "iracing-sdk",
    nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: "claim-driver", bindingScope: "installation" }),
    revision: 1, confirmation: "native_verified" as const,
  };
  const stint: DriverAttributionStint = {
    gameId: "iracing", source: binding.sourceKind, sessionId: String(native), clockDomain: "claim-source-clock",
    startMs: 0, endMs: 90_000, evidenceValidUntilMs: 90_000, bindingRevision: 1, bindingSnapshot: binding, attribution: "Self",
    actor: { gameId: "iracing", source: binding.sourceKind, actorId: "claim-driver", bindingScope: "installation",
      sessionId: String(native), clockDomain: "claim-source-clock", observedAtMs: 0 },
  };
  await setLapDriverAttribution(nativeLap, [stint], "Self", { domain: "claim-source-clock", startMs: 0, endMs: 90_000 });
  const evidence = () => db.select({ guid: laps.lapGuid, stints: laps.driverAttributionStints,
    attribution: laps.driverAttribution, clock: laps.sourceClockDomain, start: laps.sourceLapStartMs, end: laps.sourceLapEndMs })
    .from(laps).where(eq(laps.id, nativeLap)).get();
  const original = () => db.select({ originalActivityId: sessions.originalActivityId, native: sessions.nativeCaptureOrigin })
    .from(sessions).where(eq(sessions.id, native)).get();
  const evidenceBefore = await evidence();
  const originalBefore = await original();

  const reachedCommitBoundary = Promise.withResolvers<void>();
  const releaseCommitBoundary = Promise.withResolvers<void>();
  const originalSleep = Bun.sleep;
  let current = true;
  // This isolated process controls the actual cooperative pre-commit boundary, not the database or DAO.
  Bun.sleep = (duration: number | Date) => {
    if (duration !== 0) return originalSleep(duration);
    reachedCommitBoundary.resolve();
    return releaseCommitBoundary.promise;
  };
  try {
    const pendingClaim = claimLocalAccountOwner("owner-a", { isCurrent: () => current });
    await reachedCommitBoundary.promise;
    current = false;
    releaseCommitBoundary.resolve();
    await assert.rejects(pendingClaim, { code: "stale_state" });
  } finally {
    Bun.sleep = originalSleep;
    releaseCommitBoundary.resolve();
  }
  assert.equal(await getLocalAccountOwner(), null);
  assert.deepEqual((await db.select({ owner: sessions.ownerUserId }).from(sessions)
    .where(inArray(sessions.id, [native, borrowed])).all()).map(row => row.owner), [null, null]);
  assert.deepEqual(await original(), originalBefore);
  assert.deepEqual(await evidence(), evidenceBefore);

  await claimLocalAccountOwner("owner-a", { isCurrent: () => true });
  await claimLocalAccountOwner("owner-a", { isCurrent: () => true });
  await assert.rejects(claimLocalAccountOwner("owner-b", { isCurrent: () => true }), { code: "account_conflict" });
  assert.equal(await getLocalAccountOwner(), "owner-a");
  for (const [sessionId, expectedOwner] of [[native, "owner-a"], [borrowed, null]] as const) {
    assert.equal((await db.select({ owner: sessions.ownerUserId }).from(sessions).where(eq(sessions.id, sessionId)).get())?.owner, expectedOwner);
  }
  assert.deepEqual(await original(), originalBefore);
  assert.deepEqual(await evidence(), evidenceBefore);
  const continuedLap = await insertLap(native, 2, 88, true, null, 0);
  assert.equal((await db.select({ owner: sessions.ownerUserId }).from(sessions).where(eq(sessions.id, native)).get())?.owner, "owner-a");
  const continuedGuid = (await db.select({ guid: laps.lapGuid }).from(laps).where(eq(laps.id, continuedLap)).get())?.guid;
  assert.match(continuedGuid ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(continuedGuid, evidenceBefore?.guid);
  console.log("online-owner-claim: passed");
} finally {
  client.close();
}
