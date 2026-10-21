import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hashActivityContribution } from "@speedhq/live-client";
import { updateNativeRecordDigest } from "@raceiq/capture-splitting";
import { client } from "../../../db";
import {
  getDriverSummaryActivity,
  listDriverSummaryActivityLaps,
  putDriverSummaryActivity,
  setDriverSummaryActivityState,
} from "../../../db/driver-summary-ledger-queries";
import {
  buildLocalDriverSummary,
  getLocalDriverSummaryHolds,
  prepareDriverSummaryContributions as prepareDriverSummaryBatch,
  hasPendingDriverSummaryPreparations,
  isDriverSummaryContributionCurrent,
  listReadyDriverSummaryContributionPage,
  recordDriverSummaryReceipt,
  recordDriverSummaryHold,
  type ActivityContributionHash,
  type DriverSummaryActivityContribution,
  type PreparedDriverSummaryContribution,
} from "../../../driver-summary";
import { claimLocalAccountOwner, getLocalAccountOwner, getLocalGameBindingSnapshot, upsertLocalGameBinding } from "../../../db/local-account-queries";
import { deleteSession, insertSession } from "../../../db/session-queries";
import { insertLap } from "../../../db/lap-mutation-queries";
import { setLapDriverAttribution } from "../../../db/driver-summary-ledger-queries";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "../../../db/dashboard-summary-queries";
import { getDashboardSessionRecap } from "../../../db/dashboard-recap-queries";
import { getDashboard } from "../../../db/dashboard-queries";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import {
  closeNativeOriginalActivitySource,
  finalizeNativeOriginalActivitySource,
  registerVerifiedPortableOriginalInTransaction,
} from "../../../db/original-activity-queries";
import { bindAuthoritativeLapGuidInTransaction } from "../../../db/lap-guid";

// A correction may remove all personal laps without making the originals new again.
test("zero-personal-lap correction retains receipt and original GUID association", async () => {
  const activityId = crypto.randomUUID();
  const duplicateActivityId = crypto.randomUUID();
  const lapGuid = Bun.randomUUIDv7();
  const ownerUserId = "ledger-owner";
  const originalHash = "a".repeat(64);
  const correctedHash = "b".repeat(64);
  const base = {
    activityId, ownerUserId, gameId: "iracing", expectedCloudRevision: null,
    state: "ready" as const, heldReason: null,
  };
  try {
    await putDriverSummaryActivity({ ...base, lapGuids: [lapGuid],
      payload: { laps: 1, drivenSeconds: 90 }, contentHash: originalHash });
    await setDriverSummaryActivityState(activityId, ownerUserId, "synced", {
      cloudRevision: 1,
      receipt: { activityId, revision: 1, contentHash: originalHash },
    });
    await putDriverSummaryActivity({ ...base, lapGuids: [],
      payload: { laps: 0, drivenSeconds: 0 }, contentHash: correctedHash,
      expectedCloudRevision: 1 });

    const correction = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(correction?.lapGuidsJson).toBe("[]");
    expect(correction?.cloudRevision).toBe(1);
    expect(correction?.expectedCloudRevision).toBe(1);
    expect(JSON.parse(correction!.receiptJson!)).toMatchObject({ revision: 1, contentHash: originalHash });
    const associations = await listDriverSummaryActivityLaps(ownerUserId);
    expect(associations.find((row) => row.lapGuid === lapGuid)?.activityId).toBe(activityId);

    await expect(putDriverSummaryActivity({ ...base, activityId: duplicateActivityId,
      lapGuids: [lapGuid], payload: { laps: 1, drivenSeconds: 90 }, contentHash: originalHash }))
      .rejects.toMatchObject({ code: "activity_identity_conflict" });
    expect(await getDriverSummaryActivity(duplicateActivityId, ownerUserId)).toBeUndefined();
  } finally {
    await client.execute({ sql: "DELETE FROM driver_summary_activities WHERE activity_id IN (?,?)",
      args: [activityId, duplicateActivityId] });
  }
});

// The injected provider stands in for the SDK, not another production hash protocol.
const fixtureHash: ActivityContributionHash = (body) => body.metrics.laps === 0 ? "b".repeat(64)
  : body.metrics.drivenSeconds === 999 ? "d".repeat(64) : body.metrics.laps === 1 ? "c".repeat(64) : "a".repeat(64);
function contribution(activityId: string, lapGuids: string[]): DriverSummaryActivityContribution {
  return {
    schemaVersion: 2, activityId, lapGuids, expectedRevision: null, contentHash: "a".repeat(64), gameId: "acc",
    metrics: { laps: lapGuids.length, positiveLaps: lapGuids.length, validLaps: lapGuids.length,
      drivenSeconds: 60 * lapGuids.length, validSeconds: 60 * lapGuids.length, distanceMeters: null,
      sessionTypeSeconds: { practice: 0, qualifying: 0, race: 0, unknown: 0 }, sessionsWithDuration: 0, sessionsWithoutDuration: 1 },
    cars: [], tracks: [], coverage: { identity: "complete", driverAttribution: "complete",
      sessionDuration: "unavailable", distance: "partial" },
  };
}

async function prepareDriverSummaryContributions(hash: ActivityContributionHash) {
  const prepared: PreparedDriverSummaryContribution[] = [];
  do {
    prepared.push(...await prepareDriverSummaryBatch(hash));
  } while (await hasPendingDriverSummaryPreparations());
  return prepared;
}

test("owner readback confirms matching canonical content at newer or equal revisions and rejects stale or mismatched bodies", async () => {
  const { activityId, sessionId, ownerUserId } = await closedOriginal();
  const prepared = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
  const body = prepared.payload as DriverSummaryActivityContribution;
  const lapGuids = body.lapGuids;
  try {
    await putDriverSummaryActivity({ activityId, ownerUserId, gameId: "acc", lapGuids, payload: body,
      contentHash: body.contentHash, expectedCloudRevision: 1, state: "conflict", heldReason: "remote revision conflict" });
    const receipt = { activityId, revision: 4, contentHash: body.contentHash };
    await expect(Reflect.apply(recordDriverSummaryReceipt, undefined, [receipt])).rejects.toMatchObject({ code: "activity_owner_conflict" });
    await expect(recordDriverSummaryReceipt(receipt, {
      source: "owner_readback", ownerUserId: "foreign-owner", status: "confirmed", contribution: body, hash: fixtureHash,
    })).rejects.toMatchObject({ code: "activity_owner_conflict" });
    await recordDriverSummaryReceipt(receipt, { source: "owner_readback", ownerUserId, status: "confirmed", contribution: body, hash: fixtureHash });
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({
      state: "synced", cloudRevision: 4, heldReason: null,
    });
    await setDriverSummaryActivityState(activityId, ownerUserId, "conflict", { heldReason: "authoritative hold" });
    await recordDriverSummaryReceipt(receipt, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: { ...body, lapGuids: [...body.lapGuids].reverse() }, hash: fixtureHash,
    });
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "synced", heldReason: null });
    await expect(recordDriverSummaryReceipt({ ...receipt, revision: 3 },
      { source: "owner_readback", ownerUserId, status: "confirmed", contribution: body, hash: fixtureHash }))
      .rejects.toMatchObject({ code: "activity_revision_conflict" });
    await expect(recordDriverSummaryReceipt({ ...receipt, revision: 5 }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: { ...body, metrics: { ...body.metrics, drivenSeconds: 999 } }, hash: fixtureHash,
    })).rejects.toMatchObject({ code: "activity_revision_conflict" });
    expect((await getDriverSummaryActivity(activityId, ownerUserId))?.cloudRevision).toBe(4);
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

function sourceStint(attribution: "Self" | "Other", revision = 1, offset = 0): DriverAttributionStint {
  return { gameId: "acc", source: "native", sessionId: "captured-session", startMs: offset, endMs: offset + 100,
    evidenceValidUntilMs: offset + 100, clockDomain: "source-clock", attribution, bindingRevision: revision,
    actor: { gameId: "acc", source: "native", actorId: attribution === "Self" ? "self" : "other",
      bindingScope: "installation", sessionId: "captured-session", clockDomain: "source-clock", observedAtMs: offset } };
}

async function publishMetadata(sessionId: number): Promise<void> {
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  if (!candidate) throw new Error("Fixture session lacks dashboard state");
  await publishDashboardSession(candidate);
}

test("personal query excludes immutable foreign owner while retaining unassigned local history and reports index building", async () => {
  await claimLocalAccountOwner("owner-a");
  const owned = await insertSession("summary-car", "summary-track", "acc", "race");
  const foreign = await insertSession("summary-car", "summary-track", "acc", "race");
  const request = { from: "2025-04-10T00:00:00.000Z", to: "2025-04-11T00:00:00.000Z", gameId: "acc" as const };
  try {
    for (const id of [owned, foreign]) {
      await client.execute({ sql: "UPDATE sessions SET created_at='2025-04-10 12:00:00' WHERE id=?", args: [id] });
      const lapId = await insertLap(id, 1, 60, true, null, 0);
      await client.execute({ sql: "UPDATE laps SET created_at='2025-04-10 12:01:00' WHERE id=?", args: [lapId] });
      await setLapDriverAttribution(lapId, [sourceStint("Self")], "Self", { domain: "source-clock", startMs: 10, endMs: 90 });
    }
    await client.execute({ sql: "UPDATE sessions SET owner_user_id='foreign-owner' WHERE id=?", args: [foreign] });
    await expect(buildLocalDriverSummary(request)).rejects.toMatchObject({ code: "building", status: 202 });
    await publishMetadata(owned);
    // Foreign metadata is still missing: it must not block or contribute to this user's view.
    const summary = await buildLocalDriverSummary(request);
    expect(summary.summary.metrics).toMatchObject({ laps: 1, drivenSeconds: 60 });
    expect(summary.coverage.identity).toBe("partial");
    expect(summary.coverage.sessionDuration).toBe("unavailable");
    const holds = await getLocalDriverSummaryHolds();
    expect(holds.heldAmbiguous).toBeGreaterThanOrEqual(1);
    const boundaryLap = await insertLap(owned, 2, 90, true, null, 0);
    await client.execute({ sql: "UPDATE laps SET created_at=? WHERE id=?", args: [request.to, boundaryLap] });
    await setLapDriverAttribution(boundaryLap, [sourceStint("Self")], "Self", { domain: "source-clock", startMs: 10, endMs: 90 });
    await publishMetadata(owned);
    expect((await buildLocalDriverSummary(request)).summary.metrics.laps).toBe(1);
    // A missing lap index must not turn an in-period lap from an older session into ready zeros.
    await client.execute({ sql: "UPDATE sessions SET created_at='2025-04-09 12:00:00' WHERE id=?", args: [owned] });
    await publishMetadata(owned);
    await client.execute({ sql: "DELETE FROM dashboard_lap_index WHERE session_id=?", args: [owned] });
    await expect(buildLocalDriverSummary(request)).rejects.toMatchObject({ code: "building", status: 202 });
  } finally {
    await deleteSession(owned);
    await deleteSession(foreign);
  }
});

test("missing original identity or GUID and native rows without full-source proof remain local held sources", async () => {
  const before = await getLocalDriverSummaryHolds();
  const ownerUserId = await getLocalAccountOwner();
  const portableActivityId = crypto.randomUUID();
  const legacy = await insertSession("held-car", "held-track", "acc");
  const missingGuid = await insertSession("held-car", "held-track", "acc", undefined, undefined, "mine",
    { kind: "portable_import", originalActivityId: portableActivityId });
  const native = await insertSession("held-car", "held-track", "acc", undefined, undefined, "mine", { kind: "native_capture" });
  try {
    for (const id of [legacy, missingGuid, native]) {
      const lapId = await insertLap(id, 1, 60, true, null, 0);
      await setLapDriverAttribution(lapId, [sourceStint("Self")], "Self",
        { domain: "source-clock", startMs: 10, endMs: 90 });
    }
    const nativeRow = await client.execute({ sql: "SELECT original_activity_id FROM sessions WHERE id=?", args: [native] });
    const nativeActivityId = String(nativeRow.rows[0]!.original_activity_id);
    const prepared = await prepareDriverSummaryContributions(fixtureHash);
    expect(prepared.filter((item) => item.activityId === portableActivityId || item.activityId === nativeActivityId)).toEqual([]);
    expect(await getDriverSummaryActivity(portableActivityId, null)).toBeUndefined();
    expect(await getDriverSummaryActivity(nativeActivityId, ownerUserId)).toBeUndefined();
    const after = await getLocalDriverSummaryHolds();
    expect(after).toEqual({ heldAmbiguous: before.heldAmbiguous + 3, heldLaps: before.heldLaps + 3 });
  } finally {
    for (const id of [legacy, missingGuid, native]) await deleteSession(id);
  }
});

async function closedOriginal() {
  await claimLocalAccountOwner("owner-a");
  const sessionId = await insertSession("summary-car", "summary-track", "acc", "race", undefined, "mine", { kind: "native_capture" });
  const lapIds: number[] = [];
  for (let index = 0; index < 2; index++) {
    const lapId = await insertLap(sessionId, index + 1, 60, true, null, 0);
    lapIds.push(lapId);
    await setLapDriverAttribution(lapId, [sourceStint("Self", 1, index * 100)], "Self",
      { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
  }
  await closeNativeOriginalActivitySource(sessionId, { sourceRevision: crypto.randomUUID(), lapCount: 2, gapCount: 0 });
  await finalizeNativeOriginalActivitySource(sessionId);
  const row = await client.execute({ sql: "SELECT original_activity_id FROM sessions WHERE id=?", args: [sessionId] });
  const activityId = String(row.rows[0]!.original_activity_id);
  return { sessionId, activityId, lapIds, ownerUserId: "owner-a" };
}

async function cleanupActivityFixture(activityId: string): Promise<void> {
  await client.execute({ sql: "DELETE FROM driver_summary_activities WHERE activity_id=?", args: [activityId] });
  await client.execute({ sql: "DELETE FROM original_activity_source_laps WHERE original_activity_id=?", args: [activityId] });
  await client.execute({ sql: "DELETE FROM original_activity_sources WHERE original_activity_id=?", args: [activityId] });
}

test("query corrections replace the same original with zero Self while semantic reordering and local deletion never re-admit confirmed activity", async () => {
  const original = await closedOriginal();
  const { activityId, sessionId, ownerUserId } = original;
  const previousBinding = (await getLocalGameBindingSnapshot()).bindings.find((binding) => binding.gameId === "acc");
  const bindingRevision = (previousBinding?.revision ?? 0) + 1;
  try {
    const input = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    expect(input.state).toBe("ready");
    expect((input.payload as DriverSummaryActivityContribution).metrics.laps).toBe(2);
    await upsertLocalGameBinding({
      id: previousBinding?.id ?? crypto.randomUUID(), gameId: "acc", sourceKind: "native",
      nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: "same-user-current-session", bindingScope: "session", sessionId: "new-native-session" }),
      confirmation: "user_confirmed", revision: bindingRevision,
    });
    await prepareDriverSummaryContributions(fixtureHash);
    const historical = await getDriverSummaryActivity(activityId, ownerUserId);
    expect((JSON.parse(historical!.payloadJson) as DriverSummaryActivityContribution).metrics.laps).toBe(2);
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: input.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: input.payload as DriverSummaryActivityContribution, hash: fixtureHash });
    const body = input.payload as DriverSummaryActivityContribution;
    await putDriverSummaryActivity({ ...input, payload: { ...body, lapGuids: [...body.lapGuids].reverse() },
      state: "synced", expectedCloudRevision: 1 });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)).toBeUndefined();
    expect((await getDriverSummaryActivity(activityId, ownerUserId))?.state).toBe("synced");

    for (const [index, lapId] of original.lapIds.entries()) await setLapDriverAttribution(lapId, [sourceStint("Other", 1, index * 100)], "Other",
      { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
    const zero = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    expect(zero).toMatchObject({ activityId, state: "ready", lapGuids: [], expectedCloudRevision: 1 });
    expect((zero.payload as DriverSummaryActivityContribution).metrics).toMatchObject({ laps: 0, drivenSeconds: 0 });
    expect((await listDriverSummaryActivityLaps(ownerUserId)).filter((row) => row.activityId === activityId).map((row) => row.lapGuid).sort())
      .toEqual([...body.lapGuids].sort());
    await recordDriverSummaryReceipt({ activityId, revision: 2, contentHash: zero.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: zero.payload as DriverSummaryActivityContribution, hash: fixtureHash });
    await deleteSession(sessionId);
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)).toBeUndefined();
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "synced", cloudRevision: 2, lapGuidsJson: "[]" });
  } finally {
    if (previousBinding) await upsertLocalGameBinding({ ...previousBinding, revision: bindingRevision + 1 });
    else await client.execute({ sql: "DELETE FROM local_game_bindings WHERE game_id='acc'" });
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("local re-preparation cannot clear a remote conflict or reinterpret a partial native original as a full correction", async () => {
  const original = await closedOriginal();
  const { activityId, sessionId, ownerUserId } = original;
  try {
    const input = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: input.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: input.payload as DriverSummaryActivityContribution, hash: fixtureHash });
    await setDriverSummaryActivityState(activityId, ownerUserId, "conflict", { heldReason: "remote conflict requires owner readback" });
    await prepareDriverSummaryContributions(fixtureHash);
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({
      state: "conflict", heldReason: "remote conflict requires owner readback", cloudRevision: 1,
    });
    for (const [index, lapId] of original.lapIds.entries()) await setLapDriverAttribution(lapId, [sourceStint("Other", 1, index * 100)], "Other",
      { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
    const heldCorrection = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    expect(heldCorrection.state).toBe("conflict");
    await client.execute({ sql: "DELETE FROM laps WHERE id=?", args: [original.lapIds[0]!] });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)).toBeUndefined();
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "conflict", cloudRevision: 1 });
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("verified full portable originals may contribute, but historical GUID receipts cannot be recounted under a new original", async () => {
  await claimLocalAccountOwner("owner-a");
  const activityId = crypto.randomUUID(), priorActivityId = crypto.randomUUID();
  const lapGuid = Bun.randomUUIDv7(), ownerUserId = "owner-a";
  const sessionId = await insertSession("portable-car", "portable-track", "acc", "race", undefined, "mine",
    { kind: "portable_import", originalActivityId: activityId });
  try {
    await client.execute({ sql: "UPDATE sessions SET owner_user_id=? WHERE id=?", args: [ownerUserId, sessionId] });
    const lapId = await insertLap(sessionId, 1, 60, true, null, 0);
    await setLapDriverAttribution(lapId, [sourceStint("Self")], "Self",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    const nativeBytes = Buffer.from("portable-fixture-native-record");
    const nativeDigest = createHash("sha256");
    updateNativeRecordDigest(nativeDigest, { kind: "frame", offset: 0, endOffset: nativeBytes.length,
      frame: nativeBytes, frameTimeMs: 1_000 });
    const nativeRecordHash = `sha256:${nativeDigest.digest("hex")}`;
    const tx = await client.transaction("write");
    try {
      await bindAuthoritativeLapGuidInTransaction(tx, lapId, lapGuid);
      await registerVerifiedPortableOriginalInTransaction(tx, sessionId, {
        schemaVersion: 1, originalActivityId: activityId, sourceRevision: crypto.randomUUID(), originalLapGuids: [lapGuid],
        coverage: "complete", origin: "verified_portable", ownerUserId,
      }, nativeRecordHash);
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    const admitted = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    expect(admitted).toMatchObject({ state: "ready", lapGuids: [lapGuid] });
    // Simulate a retained receipt footprint after the original's zero correction, without a live source row.
    await client.execute({ sql: "DELETE FROM driver_summary_activities WHERE activity_id=?", args: [activityId] });
    const prior = contribution(priorActivityId, [lapGuid]);
    await putDriverSummaryActivity({ activityId: priorActivityId, ownerUserId, gameId: "acc", lapGuids: [lapGuid],
      payload: prior, contentHash: prior.contentHash, expectedCloudRevision: null, state: "ready", heldReason: null });
    await putDriverSummaryActivity({ activityId: priorActivityId, ownerUserId, gameId: "acc", lapGuids: [],
      payload: { ...prior, lapGuids: [], metrics: { ...prior.metrics, laps: 0 } },
      contentHash: "b".repeat(64), expectedCloudRevision: 1, state: "synced", heldReason: null });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)).toBeUndefined();
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toBeUndefined();
    expect((await listDriverSummaryActivityLaps(ownerUserId)).find((row) => row.lapGuid === lapGuid)?.activityId).toBe(priorActivityId);
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
    await cleanupActivityFixture(priorActivityId);
  }
});

test("removing part of a native source cannot reduce its confirmed full-original contribution", async () => {
  const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
  try {
    const input = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: input.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: input.payload as DriverSummaryActivityContribution, hash: fixtureHash });
    await client.execute({ sql: "DELETE FROM laps WHERE id=?", args: [lapIds[0]!] });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)).toBeUndefined();
    const retained = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(retained).toMatchObject({ state: "synced", cloudRevision: 1, contentHash: input.contentHash });
    expect((JSON.parse(retained!.payloadJson) as DriverSummaryActivityContribution).metrics.laps).toBe(2);
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("full-source reinterpretation as Unknown still emits a same-ID zero-personal correction", async () => {
  const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
  try {
    const input = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: input.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: input.payload as DriverSummaryActivityContribution, hash: fixtureHash });
    for (const [index, lapId] of lapIds.entries()) await setLapDriverAttribution(lapId, [], "Unknown",
      { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
    const correction = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    expect(correction).toMatchObject({ state: "ready", expectedCloudRevision: 1, lapGuids: [] });
    expect((correction.payload as DriverSummaryActivityContribution).metrics).toMatchObject({ laps: 0, drivenSeconds: 0 });
    expect((correction.payload as DriverSummaryActivityContribution).coverage.driverAttribution).toBe("partial");
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("oversized unresolved attribution stays pending until actual dashboard materialization excludes its Unknown laps", async () => {
  const sessionId = await insertSession("bounded-car", "bounded-track", "acc");
  const request = { from: "2051-05-12T00:00:00.000Z", to: "2051-05-13T00:00:00.000Z", gameId: "acc" as const };
  try {
    await client.execute({ sql: "UPDATE sessions SET created_at='2051-05-12 12:00:00' WHERE id=?", args: [sessionId] });
    await client.execute({
      sql: `WITH RECURSIVE source_laps(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM source_laps WHERE n<32769)
        INSERT INTO laps(session_id,lap_number,lap_time,is_valid,created_at)
        SELECT ?,n,1,1,'2051-05-12 12:01:00' FROM source_laps`,
      args: [sessionId],
    });
    expect((await getDashboard(request)).coverage).toMatchObject({ status: "pending", metadataComplete: false });
    await publishMetadata(sessionId);
    const materialized = await getDashboard(request);
    expect(materialized.coverage).toMatchObject({ status: "complete", metadataComplete: true });
    expect(materialized.totals).toMatchObject({ laps: 0, drivenSeconds: 0 });
  } finally {
    await deleteSession(sessionId);
  }
}, 30_000);

test("actual dashboard materialization and exact-edge fallbacks exclude Other, Mixed, Unknown and borrowed laps", async () => {
  await claimLocalAccountOwner("owner-a");
  const sessionId = await insertSession("personal-car", "personal-track", "acc", "race");
  const borrowed = await insertSession("borrowed-car", "borrowed-track", "acc", "race", undefined, "others");
  const request = { from: "2025-05-12T12:00:00.000Z", to: "2025-05-12T12:10:00.000Z", gameId: "acc" as const };
  let selfLapId = 0;
  try {
    for (const id of [sessionId, borrowed]) {
      await client.execute({ sql: "UPDATE sessions SET created_at='2025-05-12 12:01:00' WHERE id=?", args: [id] });
    }
    const attributions = [
      [sourceStint("Self")],
      [sourceStint("Other")],
      [{ ...sourceStint("Self"), endMs: 50 }, { ...sourceStint("Other"), startMs: 50 }],
      [],
    ];
    for (const [index, stints] of attributions.entries()) {
      const lapId = await insertLap(sessionId, index + 1, 60 + index * 10, true, null, 0);
      if (index === 0) selfLapId = lapId;
      await client.execute({ sql: "UPDATE laps SET created_at='2025-05-12 12:02:00' WHERE id=?", args: [lapId] });
      await setLapDriverAttribution(lapId, stints, index === 0 ? "Self" : index === 1 ? "Other" : index === 2 ? "Mixed" : "Unknown",
        { domain: "source-clock", startMs: 10, endMs: 90 });
    }
    const borrowedLap = await insertLap(borrowed, 1, 500, true, null, 0);
    await client.execute({ sql: "UPDATE laps SET created_at='2025-05-12 12:02:00' WHERE id=?", args: [borrowedLap] });
    await setLapDriverAttribution(borrowedLap, [sourceStint("Self")], "Self", { domain: "source-clock", startMs: 10, endMs: 90 });
    const unpublished = await getDashboard(request);
    expect(unpublished.totals).toMatchObject({ laps: 1, positiveLaps: 1, drivenSeconds: 60, validSeconds: 60 });
    expect(unpublished.coverage.status).toBe("pending");
    await publishMetadata(sessionId);
    const dashboard = await getDashboard(request);
    expect(dashboard.totals).toMatchObject({ laps: 1, positiveLaps: 1, drivenSeconds: 60, validSeconds: 60 });
    expect(dashboard.cards.acc).toEqual({ laps: 1, drivenSeconds: 60 });
    expect(dashboard.favouriteCar).toMatchObject({ nativeId: "personal-car", seconds: 60, laps: 1 });
    const wholeDay = await getDashboard({ ...request, from: "2025-05-12T00:00:00.000Z", to: "2025-05-13T00:00:00.000Z" });
    expect(wholeDay.totals).toMatchObject({ laps: 1, drivenSeconds: 60 });
    const personal = await buildLocalDriverSummary(request);
    expect(personal.summary.metrics).toMatchObject({ laps: 1, drivenSeconds: 60 });
    expect(personal.context).toEqual({ basis: "positive_lap_time",
      other: { laps: 1, seconds: 70 }, mixed: { laps: 1, seconds: 80 }, unknown: { laps: 1, seconds: 90 } });
    await setLapDriverAttribution(selfLapId, [], "Unknown", { domain: "source-clock", startMs: 10, endMs: 90 });
    const corrected = await getDashboard({ ...request, to: "2025-05-12T12:15:00.000Z" });
    expect(corrected.totals).toMatchObject({ laps: 0, drivenSeconds: 0 });
    expect(corrected.calendar.find((bucket) => bucket.day === "2025-05-12")).toMatchObject({ positiveLaps: 0, drivenSeconds: 0 });
    const correctedDay = await getDashboard({ ...request, from: "2025-05-12T00:00:00.000Z", to: "2025-05-13T00:00:00.000Z" });
    expect(correctedDay.totals).toMatchObject({ laps: 0, drivenSeconds: 0 });
  } finally {
    await deleteSession(sessionId);
    await deleteSession(borrowed);
  }
});

test("persisted source generations skip unchanged preparation and fence a concurrent source correction", async () => {
  const { activityId, sessionId, lapIds } = await closedOriginal();
  let hashCalls = 0;
  const hash: ActivityContributionHash = (payload) => {
    hashCalls++;
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  };
  try {
    const initial = (await prepareDriverSummaryContributions(hash)).find((item) => item.activityId === activityId)!;
    expect(await isDriverSummaryContributionCurrent(activityId, initial.contentHash)).toBe(true);
    const calls = hashCalls;
    expect(await prepareDriverSummaryContributions(hash)).toEqual([]);
    expect(hashCalls).toBe(calls);
    await setLapDriverAttribution(lapIds[0]!, [sourceStint("Other")], "Other",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    let changed = false;
    const racingHash: ActivityContributionHash = async (payload) => {
      if (!changed && payload.activityId === activityId) {
        changed = true;
        await client.execute({ sql: "UPDATE laps SET lap_time=90 WHERE id=?", args: [lapIds[1]!] });
      }
      return hash(payload);
    };
    const stale = await prepareDriverSummaryBatch(racingHash);
    expect(stale.find((item) => item.activityId === activityId)).toBeUndefined();
    expect(await hasPendingDriverSummaryPreparations()).toBe(true);
    expect(await isDriverSummaryContributionCurrent(activityId, initial.contentHash)).toBe(false);
    const corrected = (await prepareDriverSummaryContributions(hash)).find((item) => item.activityId === activityId)!;
    expect((corrected.payload as DriverSummaryActivityContribution).metrics).toMatchObject({ laps: 1, drivenSeconds: 90 });
    expect(await isDriverSummaryContributionCurrent(activityId, corrected.contentHash)).toBe(true);
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("complete original membership with an Unknown lap contributes only independently proven Self metrics", async () => {
  const { activityId, sessionId, lapIds } = await closedOriginal();
  try {
    await setLapDriverAttribution(lapIds[0]!, [], "Unknown", { domain: "source-clock", startMs: 10, endMs: 90 });
    const prepared = (await prepareDriverSummaryContributions(fixtureHash)).find((item) => item.activityId === activityId)!;
    expect(prepared.state).toBe("ready");
    const body = prepared.payload as DriverSummaryActivityContribution;
    expect(body.metrics).toMatchObject({ laps: 1, drivenSeconds: 60 });
    expect(body.lapGuids).toHaveLength(1);
    expect(body.coverage).toMatchObject({ identity: "complete", driverAttribution: "partial" });
    expect("context" in body).toBe(false);
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

for (const operation of ["INSERT", "UPDATE"] as const) {
  test(`source generation changing during ledger ${operation} rolls back publication and historical associations`, async () => {
    const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
    const trigger = `ledger_generation_race_${activityId.replaceAll("-", "")}`;
    try {
      if (operation === "UPDATE") {
        const initial = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
        await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: initial.contentHash }, {
          source: "owner_readback", ownerUserId, status: "confirmed", contribution: initial.payload as DriverSummaryActivityContribution, hash: fixtureHash });
        await setLapDriverAttribution(lapIds[0]!, [sourceStint("Other")], "Other",
          { domain: "source-clock", startMs: 10, endMs: 90 });
      }
      const prior = await getDriverSummaryActivity(activityId, ownerUserId);
      const associations = (await listDriverSummaryActivityLaps(ownerUserId)).filter((row) => row.activityId === activityId);
      const before = await client.execute({ sql: "SELECT * FROM original_activity_preparations WHERE original_activity_id=?", args: [activityId] });
      await client.execute(`CREATE TRIGGER ${trigger} AFTER ${operation} ON driver_summary_activities
        WHEN NEW.activity_id='${activityId}' BEGIN
          UPDATE original_activity_preparations SET generation=generation+1 WHERE original_activity_id=NEW.activity_id;
        END`);
      const prepared = await prepareDriverSummaryBatch(fixtureHash);
      expect(prepared.find((row) => row.activityId === activityId)).toBeUndefined();
      expect(await getDriverSummaryActivity(activityId, ownerUserId)).toEqual(prior);
      expect((await listDriverSummaryActivityLaps(ownerUserId)).filter((row) => row.activityId === activityId)).toEqual(associations);
      const after = await client.execute({ sql: "SELECT * FROM original_activity_preparations WHERE original_activity_id=?", args: [activityId] });
      expect(after.rows).toEqual(before.rows);
      expect(after.rows[0]!.generation).not.toBe(after.rows[0]!.prepared_generation);
      await client.execute(`DROP TRIGGER ${trigger}`);
      const retry = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
      expect(retry).toMatchObject({ state: "ready", expectedCloudRevision: operation === "UPDATE" ? 1 : null });
      expect((retry.payload as DriverSummaryActivityContribution).metrics.laps).toBe(operation === "UPDATE" ? 1 : 2);
    } finally {
      await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
      await deleteSession(sessionId);
      await cleanupActivityFixture(activityId);
    }
  });
}

test("held B baseline retains pending A and confirmed A history across A-to-B-to-A corrections", async () => {
  const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
  try {
    const initial = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    const initialBody = initial.payload as DriverSummaryActivityContribution;
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: initial.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: initialBody, hash: fixtureHash });
    await setLapDriverAttribution(lapIds[0]!, [sourceStint("Other")], "Other",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    const b = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    const receipt = { activityId, revision: 2, contentHash: b.contentHash };
    await setLapDriverAttribution(lapIds[0]!, [sourceStint("Self")], "Self",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    const pendingA = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    await recordDriverSummaryHold({ receipt, contribution: b.payload as DriverSummaryActivityContribution,
      status: "held", holdReason: "Pending identity confirmation" }, { ownerUserId, hash: fixtureHash });
    const retained = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(retained).toMatchObject({ state: "ready", contentHash: pendingA.contentHash, cloudRevision: 1,
      expectedCloudRevision: 2, heldCloudRevision: 2 });
    expect(JSON.parse(retained!.payloadJson)).toEqual({ ...initialBody, expectedRevision: 2 });
    expect(JSON.parse(retained!.receiptJson!)).toMatchObject({ revision: 1, contentHash: initial.contentHash });
    expect(JSON.parse(retained!.heldReceiptJson!)).toEqual(receipt);
    await expect(recordDriverSummaryReceipt({ activityId, revision: 2, contentHash: initial.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed", contribution: initialBody, hash: fixtureHash }))
      .rejects.toMatchObject({ code: "activity_revision_conflict" });
    await setLapDriverAttribution(lapIds[0]!, [sourceStint("Other")], "Other",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)).toBeUndefined();
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({
      state: "held_ambiguous", contentHash: b.contentHash, cloudRevision: 1, heldCloudRevision: 2,
    });
    await client.execute({ sql: "UPDATE laps SET lap_time=lap_time WHERE id=?", args: [lapIds[0]!] });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)).toBeUndefined();
    await setLapDriverAttribution(lapIds[0]!, [sourceStint("Self")], "Self",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    const correctionA = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    expect(correctionA).toMatchObject({ state: "ready", contentHash: initial.contentHash, expectedCloudRevision: 2 });
    expect((await getDriverSummaryActivity(activityId, ownerUserId))?.state).toBe("ready");
    await recordDriverSummaryReceipt({ activityId, revision: 3, contentHash: correctionA.contentHash }, {
      source: "owner_readback", ownerUserId, status: "confirmed",
      contribution: correctionA.payload as DriverSummaryActivityContribution, hash: fixtureHash,
    });
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "synced", cloudRevision: 3 });
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("held revision zero permits a changed correction but unchanged held content stays readback-only", async () => {
  const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
  try {
    const a = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    const zero = contribution(activityId, []);
    zero.contentHash = "b".repeat(64);
    await recordDriverSummaryHold({ receipt: { activityId, revision: 0, contentHash: zero.contentHash },
      contribution: zero, status: "held", holdReason: "No personal attribution" }, { ownerUserId, hash: fixtureHash });
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({
      state: "ready", expectedCloudRevision: 0, heldCloudRevision: 0, cloudRevision: null, receiptJson: null, contentHash: a.contentHash,
    });
    for (const [index, lapId] of lapIds.entries()) await setLapDriverAttribution(lapId, [sourceStint("Other", 1, index * 100)], "Other",
      { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
    expect((await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)).toBeUndefined();
    const held = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(held).toMatchObject({ state: "held_ambiguous", expectedCloudRevision: 0, contentHash: zero.contentHash, cloudRevision: null });
    expect(JSON.parse(held!.payloadJson).metrics.laps).toBe(0);
    expect((await listDriverSummaryActivityLaps(ownerUserId)).filter((row) => row.activityId === activityId).map((row) => row.lapGuid).sort())
      .toEqual([...a.lapGuids].sort());
    await setLapDriverAttribution(lapIds[0]!, [sourceStint("Self")], "Self",
      { domain: "source-clock", startMs: 10, endMs: 90 });
    const changed = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    expect(changed).toMatchObject({ state: "ready", expectedCloudRevision: 0 });
    expect((changed.payload as DriverSummaryActivityContribution).metrics.laps).toBe(1);
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("held readback rejects foreign owners, malformed canonical bodies, other originals and stale or conflicting revisions", async () => {
  const { activityId, sessionId, ownerUserId } = await closedOriginal();
  try {
    const input = (await prepareDriverSummaryContributions(fixtureHash)).find((row) => row.activityId === activityId)!;
    const body = input.payload as DriverSummaryActivityContribution;
    const view = { receipt: { activityId, revision: 2, contentHash: input.contentHash }, contribution: body,
      status: "held" as const, holdReason: "Identity pending" };
    await expect(recordDriverSummaryHold(view, { ownerUserId: "foreign-owner", hash: fixtureHash }))
      .rejects.toMatchObject({ code: "activity_owner_conflict" });
    await expect(recordDriverSummaryHold({ ...view, contribution: { ...body, metrics: { ...body.metrics, validLaps: -1 } } },
      { ownerUserId, hash: fixtureHash })).rejects.toMatchObject({ code: "activity_revision_conflict" });
    await expect(recordDriverSummaryHold({ ...view, contribution: { ...body, lapGuids: [Bun.randomUUIDv7(), body.lapGuids[1]!] } },
      { ownerUserId, hash: fixtureHash })).rejects.toMatchObject({ code: "activity_identity_conflict" });
    await expect(recordDriverSummaryHold({ ...view, contribution: { ...body, activityId: crypto.randomUUID() } },
      { ownerUserId, hash: fixtureHash })).rejects.toMatchObject({ code: "activity_revision_conflict" });
    await recordDriverSummaryHold(view, { ownerUserId, hash: fixtureHash });
    await expect(recordDriverSummaryHold({ ...view, receipt: { ...view.receipt, revision: 1 } }, { ownerUserId, hash: fixtureHash }))
      .rejects.toMatchObject({ code: "activity_revision_conflict" });
    const b = contribution(activityId, [body.lapGuids[0]!]);
    b.contentHash = "c".repeat(64);
    await expect(recordDriverSummaryHold({ ...view, receipt: { ...view.receipt, contentHash: b.contentHash }, contribution: b },
      { ownerUserId, hash: fixtureHash })).rejects.toMatchObject({ code: "activity_revision_conflict" });
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({
      state: "held_ambiguous", contentHash: input.contentHash, cloudRevision: null, heldCloudRevision: 2, receiptJson: null,
    });
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("ready contribution keyset pages exclude held, synced and foreign records across page transitions", async () => {
  await claimLocalAccountOwner("owner-a");
  const prefix = `ready-page-${crypto.randomUUID()}`;
  const ids = [1, 2, 3, 4, 5].map((index) => `${prefix}-${index}`);
  try {
    for (let index = 0; index < ids.length; index++) {
      await putDriverSummaryActivity({
        activityId: ids[index]!, ownerUserId: index === 4 ? "foreign-owner" : "owner-a", gameId: "acc", lapGuids: [],
        payload: {}, contentHash: "a".repeat(64), expectedCloudRevision: null,
        state: index === 1 ? "synced" : index === 3 ? "held_ambiguous" : "ready", heldReason: null,
      });
    }
    const first = await listReadyDriverSummaryContributionPage(prefix, 1);
    expect(first.items.map((row) => row.activityId)).toEqual([ids[0]!]);
    expect(first.nextCursor).toBe(ids[0]!);
    await setDriverSummaryActivityState(ids[0]!, "owner-a", "synced", {});
    const second = await listReadyDriverSummaryContributionPage(first.nextCursor, 1);
    expect(second.items.map((row) => row.activityId)).toEqual([ids[2]!]);
    expect(second.nextCursor).toBeNull();
  } finally {
    await client.execute({ sql: "DELETE FROM driver_summary_activities WHERE activity_id IN (?,?,?,?,?)", args: ids });
  }
});

test("personal dashboard recap keeps current and dirty historical Other, Mixed and Unknown laps out of personal bests", async () => {
  await claimLocalAccountOwner("owner-a");
  const car = `recap-car-${crypto.randomUUID()}`, track = `recap-track-${crypto.randomUUID()}`;
  const current = await insertSession(car, track, "acc", "race");
  const historical = await insertSession(car, track, "acc", "race");
  let selfLapId = 0;
  try {
    for (const [sessionId, ownSeconds] of [[current, 100], [historical, 90]] as const) {
      const stints: DriverAttributionStint[][] = [
        [sourceStint("Self")], [sourceStint("Other")],
        [{ ...sourceStint("Self"), endMs: 50 }, { ...sourceStint("Other"), startMs: 50 }], [],
      ];
      for (let index = 0; index < stints.length; index++) {
        const lapId = await insertLap(sessionId, index + 1, index === 0 ? ownSeconds : index * 10, true, null, 0);
        // Cached label must not substitute for actual source interval proof.
        await setLapDriverAttribution(lapId, stints[index]!, "Self", { domain: "source-clock", startMs: 10, endMs: 90 });
        if (sessionId === historical && index === 0) selfLapId = lapId;
      }
      await publishMetadata(sessionId);
    }
    expect(await getDashboardSessionRecap(current, "acc")).toMatchObject({
      lapsTotal: 1, lapsValid: 1, bestLapSec: 100, personalBest: { isNew: false, previousBestSec: 90 },
    });
    await client.execute({ sql: "UPDATE laps SET lap_time=95 WHERE id=?", args: [selfLapId] });
    expect(await getDashboardSessionRecap(current, "acc")).toMatchObject({
      lapsTotal: 1, lapsValid: 1, bestLapSec: 100, personalBest: { isNew: false, previousBestSec: 95 },
    });
    await publishMetadata(historical);
    expect((await getDashboardSessionRecap(current, "acc"))?.personalBest).toEqual({ isNew: false, previousBestSec: 95 });
  } finally {
    await deleteSession(current);
    await deleteSession(historical);
  }
});

test("confirmed old-body readback preserves pending zero and reversible corrections on their original identity", async () => {
  const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
  const owner = (body: DriverSummaryActivityContribution) => ({
    source: "owner_readback" as const, ownerUserId, status: "confirmed" as const, contribution: body, hash: hashActivityContribution,
  });
  const prepare = async () => (await prepareDriverSummaryContributions(hashActivityContribution))
    .find((row) => row.activityId === activityId)!.payload as DriverSummaryActivityContribution;
  const attribution = async (role: "Self" | "Other") => {
    for (const [index, lapId] of lapIds.entries()) await setLapDriverAttribution(lapId, [sourceStint(role, 1, index * 100)], role,
      { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
  };
  try {
    const a = await prepare();
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: a.contentHash }, owner(a));
    await attribution("Other");
    const zero = await prepare();
    expect(zero).toMatchObject({ activityId, lapGuids: [], expectedRevision: 1, metrics: { laps: 0 } });
    await attribution("Self");
    const pendingA = await prepare();
    expect(pendingA.contentHash).toBe(a.contentHash);
    await recordDriverSummaryReceipt({ activityId, revision: 2, contentHash: zero.contentHash }, owner(zero));
    const retained = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(retained).toMatchObject({ contentHash: a.contentHash, state: "ready", cloudRevision: 2,
      expectedCloudRevision: 2, heldCloudRevision: null, heldReceiptJson: null });
    expect(JSON.parse(retained!.payloadJson)).toEqual({ ...pendingA, expectedRevision: 2 });
    expect(JSON.parse(retained!.receiptJson!)).toMatchObject({ revision: 2, contentHash: zero.contentHash });
    await expect(recordDriverSummaryReceipt({ activityId, revision: 2, contentHash: a.contentHash }, owner(a)))
      .rejects.toMatchObject({ code: "activity_revision_conflict" });
    const foreign = { ...a, lapGuids: [Bun.randomUUIDv7(), a.lapGuids[1]!] };
    const { expectedRevision: _expected, contentHash: _hash, ...foreignBody } = foreign;
    foreign.contentHash = await hashActivityContribution(foreignBody);
    await expect(recordDriverSummaryReceipt({ activityId, revision: 3, contentHash: foreign.contentHash }, owner(foreign)))
      .rejects.toMatchObject({ code: "activity_identity_conflict" });
    const correctedA = { ...pendingA, expectedRevision: 2 };
    await recordDriverSummaryReceipt({ activityId, revision: 3, contentHash: correctedA.contentHash }, owner(correctedA));
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "synced", cloudRevision: 3,
      expectedCloudRevision: 3, contentHash: a.contentHash });
    await attribution("Other");
    const pendingZero = await prepare();
    await recordDriverSummaryReceipt({ activityId, revision: 3, contentHash: correctedA.contentHash }, owner(correctedA));
    const beforeZeroConfirmation = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(beforeZeroConfirmation).toMatchObject({ state: "ready", contentHash: pendingZero.contentHash,
      cloudRevision: 3, expectedCloudRevision: 3, lapGuidsJson: "[]" });
    expect(JSON.parse(beforeZeroConfirmation!.payloadJson).metrics.laps).toBe(0);
    await recordDriverSummaryReceipt({ activityId, revision: 4, contentHash: pendingZero.contentHash }, owner(pendingZero));
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "synced",
      cloudRevision: 4, expectedCloudRevision: 4, lapGuidsJson: "[]" });
    expect((await listDriverSummaryActivityLaps(ownerUserId)).filter((row) => row.activityId === activityId).map((row) => row.lapGuid).sort())
      .toEqual([...a.lapGuids].sort());
    await expect(recordDriverSummaryReceipt({ activityId, revision: 3, contentHash: correctedA.contentHash }, owner(correctedA)))
      .rejects.toMatchObject({ code: "activity_revision_conflict" });
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("source mutation during confirmed canonical verification cannot overwrite the newer pending body", async () => {
  const { activityId, sessionId, ownerUserId, lapIds } = await closedOriginal();
  try {
    const initial = (await prepareDriverSummaryContributions(hashActivityContribution)).find((row) => row.activityId === activityId)!;
    const a = initial.payload as DriverSummaryActivityContribution;
    const source = { source: "owner_readback" as const, ownerUserId, status: "confirmed" as const,
      contribution: a, hash: hashActivityContribution };
    await recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: a.contentHash }, source);
    let correction: PreparedDriverSummaryContribution | undefined;
    const racingHash: ActivityContributionHash = async (body) => {
      const hash = await hashActivityContribution(body);
      if (!correction) {
        for (const [index, lapId] of lapIds.entries()) await setLapDriverAttribution(lapId, [sourceStint("Other", 1, index * 100)], "Other",
          { domain: "source-clock", startMs: index * 100 + 10, endMs: index * 100 + 90 });
        correction = (await prepareDriverSummaryContributions(hashActivityContribution)).find((row) => row.activityId === activityId)!;
      }
      return hash;
    };
    await expect(recordDriverSummaryReceipt({ activityId, revision: 2, contentHash: a.contentHash }, { ...source, hash: racingHash }))
      .rejects.toMatchObject({ code: "stale_source" });
    const current = await getDriverSummaryActivity(activityId, ownerUserId);
    expect(current).toMatchObject({ state: "ready", contentHash: correction!.contentHash,
      cloudRevision: 1, expectedCloudRevision: 1, lapGuidsJson: "[]" });
    expect(JSON.parse(current!.payloadJson)).toEqual(correction!.payload);
    expect(JSON.parse(current!.receiptJson!)).toMatchObject({ revision: 1, contentHash: a.contentHash });
    await recordDriverSummaryReceipt({ activityId, revision: 2, contentHash: a.contentHash }, source);
    expect(await getDriverSummaryActivity(activityId, ownerUserId)).toMatchObject({ state: "ready",
      contentHash: correction!.contentHash, cloudRevision: 2, expectedCloudRevision: 2, lapGuidsJson: "[]" });
  } finally {
    await deleteSession(sessionId);
    await cleanupActivityFixture(activityId);
  }
});

test("confirmed owner readback without an original footprint stays ambiguous rather than inventing ownership", async () => {
  await claimLocalAccountOwner("owner-a");
  const activityId = crypto.randomUUID();
  const body = contribution(activityId, [Bun.randomUUIDv7(), Bun.randomUUIDv7()]);
  try {
    await putDriverSummaryActivity({ activityId, ownerUserId: "owner-a", gameId: body.gameId, lapGuids: body.lapGuids,
      payload: body, contentHash: body.contentHash, expectedCloudRevision: null, state: "held_ambiguous", heldReason: "Missing original footprint" });
    await expect(recordDriverSummaryReceipt({ activityId, revision: 1, contentHash: body.contentHash }, {
      source: "owner_readback", ownerUserId: "owner-a", status: "confirmed", contribution: body, hash: fixtureHash,
    })).rejects.toMatchObject({ code: "activity_identity_ambiguous" });
    expect(await getDriverSummaryActivity(activityId, "owner-a")).toMatchObject({
      state: "held_ambiguous", contentHash: body.contentHash, cloudRevision: null, expectedCloudRevision: null, receiptJson: null,
    });
  } finally {
    await client.execute({ sql: "DELETE FROM driver_summary_activities WHERE activity_id=?", args: [activityId] });
  }
});
