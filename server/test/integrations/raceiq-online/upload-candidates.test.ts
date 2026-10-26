import { expect, test } from "bun:test";
import type { GameId } from "@raceiq/shared/games/ids";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { db, readDb } from "../../../db";
import { claimLocalAccountOwner, getLocalAccountOwner } from "../../../db/local-account-queries";
import { deleteSession, insertSession } from "../../../db/session-queries";
import { insertLap, updateCapturedLap, updateLapValidity } from "../../../db/lap-mutation-queries";
import { laps, onlineFastestComboLaps, onlineFastestLapInitialization, sessions } from "../../../db/schema";
import { initializeOnlineFastestLapWinners } from "../../../db/online-fastest-lap-queries";
import {
  getOnlineLapUploadStatus, getOnlineUploadWinnerPage, readOnlineLapUpload, retainOnlineLapRequest,
  setOnlineLapRetryAfter, settleOnlineLapUpload,
} from "../../../db/online-upload-queries";
import { getRecordingInstallationId } from "../../../db/recording-origin";
import { eq, sql } from "drizzle-orm";

async function ensureOwner(): Promise<string> {
  const existing = await getLocalAccountOwner();
  if (existing) return existing;
  const id = `online-fixture-${crypto.randomUUID()}`;
  await claimLocalAccountOwner(id);
  return id;
}

function selfAttribution(sessionId: number, gameId: GameId, value: "Self" | "Other" = "Self") {
  const source = `${gameId}-fixture`;
  const clockDomain = `fixture-${sessionId}`;
  const bindingSnapshot = {
    id: `fixture-binding-${gameId}`, gameId, sourceKind: source,
    nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: "fixture-driver", bindingScope: "installation" }),
    confirmation: "user_confirmed" as const, revision: 1,
  };
  const actor = {
    gameId, source, actorId: "fixture-driver", bindingScope: "installation" as const,
    sessionId: String(sessionId), clockDomain, observedAtMs: 0,
  };
  const stint: DriverAttributionStint = {
    gameId, source, sessionId: String(sessionId), clockDomain, startMs: 0, endMs: 10_000,
    evidenceValidUntilMs: 10_000, actor, attribution: value, bindingRevision: 1, bindingSnapshot,
  };
  return { stints: [stint], attribution: value, source: { domain: clockDomain, startMs: 0, endMs: 10_000 } };
}

async function addLap(input: {
  gameId?: GameId;
  trackId?: string;
  carId?: string;
  time: number;
  origin?: "native_capture" | "imported" | "unknown";
  ownership?: "mine" | "others";
  attribution?: "Self" | "Other";
  provisional?: boolean;
}) {
  const gameId = input.gameId ?? "acc" as GameId;
  const trackId = input.trackId ?? `track-${crypto.randomUUID()}`;
  const carId = input.carId ?? `car-${crypto.randomUUID()}`;
  const sourceOrigin = input.origin === "native_capture" ? { kind: "native_capture" as const }
    : input.origin === "imported" ? { kind: "portable_import" as const, originalActivityId: crypto.randomUUID() }
      : { kind: "unknown" as const };
  const sessionId = await insertSession(carId, trackId, gameId, undefined, undefined, input.ownership, sourceOrigin);
  try {
    const attribution = input.attribution ? selfAttribution(sessionId, gameId, input.attribution) : undefined;
    const lapId = await insertLap(sessionId, 1, input.provisional ? 0 : input.time, !input.provisional,
      null, 10, null, null, input.provisional ? "incomplete" : null,
      input.provisional ? null : [input.time / 3, input.time / 3, input.time / 3], undefined, undefined, attribution);
    return { sessionId, lapId, gameId, trackId, carId, attribution };
  } catch (error) {
    await deleteSession(sessionId);
    throw error;
  }
}

test("native origin is installation-bound; imported and historical origin claims stay untrusted", async () => {
  await ensureOwner();
  const native = await insertSession("origin-car", "origin-track", "iracing" as GameId, undefined, undefined, undefined, { kind: "native_capture" });
  const imported = await insertSession("import-car", "import-track", "iracing" as GameId, undefined, undefined, "others", {
    kind: "portable_import", originalActivityId: crypto.randomUUID(),
  });
  const unknown = await insertSession("unknown-car", "unknown-track", "iracing" as GameId);
  try {
    const nativeRow = await db.select({ origin: sessions.recordingOrigin, installationId: sessions.recordingInstallationId,
      activityId: sessions.originalActivityId, nativeCapture: sessions.nativeCaptureOrigin }).from(sessions).where(eq(sessions.id, native)).get();
    expect(nativeRow).toMatchObject({ origin: "native_capture", installationId: getRecordingInstallationId(), nativeCapture: true });
    expect(nativeRow?.activityId).toMatch(/^[0-9a-f-]{36}$/i);
    const importedRow = await db.select({ origin: sessions.recordingOrigin, installationId: sessions.recordingInstallationId,
      nativeCapture: sessions.nativeCaptureOrigin }).from(sessions).where(eq(sessions.id, imported)).get();
    expect(importedRow).toEqual({ origin: "imported", installationId: null, nativeCapture: false });
    const unknownRow = await db.select({ origin: sessions.recordingOrigin, installationId: sessions.recordingInstallationId })
      .from(sessions).where(eq(sessions.id, unknown)).get();
    expect(unknownRow).toEqual({ origin: "unknown", installationId: null });
  } finally {
    await deleteSession(native);
    await deleteSession(imported);
    await deleteSession(unknown);
  }
});

test("only locally recorded whole-lap Self winners are selected; strict faster updates preserve ties", async () => {
  const accountId = await ensureOwner();
  const trackId = `winner-${crypto.randomUUID()}`;
  const carId = `winner-car-${crypto.randomUUID()}`;
  const created: number[] = [];
  try {
    const fastest = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 90 });
    created.push(fastest.sessionId);
    const tie = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 90 });
    created.push(tie.sessionId);
    const slower = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 91 });
    created.push(slower.sessionId);
    const other = await addLap({ origin: "native_capture", attribution: "Other", trackId, carId, time: 80 });
    created.push(other.sessionId);
    const imported = await addLap({ origin: "imported", attribution: "Self", trackId, carId, time: 70 });
    created.push(imported.sessionId);
    const historical = await addLap({ origin: "unknown", attribution: "Self", trackId, carId, time: 60 });
    created.push(historical.sessionId);
    const foreign = await addLap({ origin: "native_capture", ownership: "others", attribution: "Self", trackId, carId, time: 50 });
    created.push(foreign.sessionId);

    const selected = await db.select({ lapId: onlineFastestComboLaps.lapId, lapTimeMs: onlineFastestComboLaps.lapTimeMs })
      .from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.gameId, "acc")).all();
    const combo = selected.find((row) => row.lapId === fastest.lapId);
    expect(combo).toEqual({ lapId: fastest.lapId, lapTimeMs: 90_000 });
    expect(selected.some((row) => [tie.lapId, slower.lapId, other.lapId, imported.lapId, historical.lapId, foreign.lapId].includes(row.lapId!))).toBe(false);

    const page = await getOnlineUploadWinnerPage(null, 250);
    expect(page.items).toContainEqual({ lapId: fastest.lapId, gameId: "acc", trackId, carId, lapTimeMs: 90_000 });
    expect(page.items.some((item) => [tie.lapId, slower.lapId, other.lapId, imported.lapId, historical.lapId, foreign.lapId].includes(item.lapId))).toBe(false);
    expect((await readOnlineLapUpload(fastest.lapId))?.accountId).toBe(accountId);

    const faster = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 89 });
    created.push(faster.sessionId);
    expect((await readOnlineLapUpload(faster.lapId))?.lapTimeMs).toBe(89_000);
    expect(await readOnlineLapUpload(fastest.lapId)).toBeNull();
  } finally {
    for (const sessionId of created) await deleteSession(sessionId);
  }
});

test("provisional completion finalizes attribution and winner atomically; invalidation and deletion clear selection", async () => {
  await ensureOwner();
  const created = await addLap({ origin: "native_capture", provisional: true, time: 92, attribution: "Self" });
  try {
    const before = await db.select({ evaluatedAt: laps.onlineEvaluatedAt, lapGuid: laps.lapGuid })
      .from(laps).where(eq(laps.id, created.lapId)).get();
    expect(before?.evaluatedAt).toBeNull();
    expect(before?.lapGuid).toMatch(/^[0-9a-f-]{36}$/i);
    await updateCapturedLap(created.lapId, created.sessionId, 1, 92, true, null, 11, null, null, null,
      [92 / 3, 92 / 3, 92 / 3], null, undefined, created.attribution);
    const after = await db.select({ evaluatedAt: laps.onlineEvaluatedAt, attribution: laps.driverAttribution })
      .from(laps).where(eq(laps.id, created.lapId)).get();
    expect(after?.evaluatedAt).toBeTruthy();
    expect(after?.attribution).toBe("Self");
    expect(await readOnlineLapUpload(created.lapId)).toBeTruthy();

    await updateLapValidity(created.lapId, false, "fixture-invalid");
    expect(await readOnlineLapUpload(created.lapId)).toBeNull();
    const winner = await db.select({ lapId: onlineFastestComboLaps.lapId }).from(onlineFastestComboLaps)
      .where(eq(onlineFastestComboLaps.gameId, created.gameId)).all();
    expect(winner.some((row) => row.lapId === created.lapId)).toBe(false);
  } finally {
    await deleteSession(created.sessionId);
  }
});

test("bounded winner initialization resumes from durable cursor and request CAS settles once", async () => {
  const accountId = await ensureOwner();
  const created = await addLap({ origin: "native_capture", attribution: "Self", time: 88 });
  const previous = await readDb.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
  try {
    await db.delete(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).run();
    await db.update(laps).set({ onlineEvaluatedAt: null }).where(eq(laps.id, created.lapId)).run();
    await db.update(onlineFastestLapInitialization).set({ lastCheckedLapId: created.lapId - 1, complete: false })
      .where(eq(onlineFastestLapInitialization.id, 1)).run();
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 1, complete: false });
    const cursor = await db.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
    expect(cursor).toMatchObject({ lastCheckedLapId: created.lapId, complete: false });
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 0, complete: true });
    expect((await readOnlineLapUpload(created.lapId))?.lapId).toBe(created.lapId);

    const request = {
      accountId, idempotencyKey: `key-${crypto.randomUUID()}`, identityJson: JSON.stringify({ lapGuid: (await readOnlineLapUpload(created.lapId))?.lapGuid }),
      payloadFingerprint: `fingerprint-${crypto.randomUUID()}`, reservationToken: "reservation-1",
    };
    expect(await retainOnlineLapRequest(created.lapId, request)).toBe(true);
    expect(await retainOnlineLapRequest(created.lapId, request)).toBe(true);
    expect(await retainOnlineLapRequest(created.lapId, { ...request, identityJson: "{}" })).toBe(false);
    expect(await setOnlineLapRetryAfter(created.lapId, request.idempotencyKey, "2026-10-23T00:01:00.000Z")).toBe(true);
    const uploadedAt = "2026-10-23T00:02:00.000Z";
    expect(await settleOnlineLapUpload(created.lapId, request.idempotencyKey, "success", "remote-job-1", uploadedAt)).toBe(true);
    expect(await settleOnlineLapUpload(created.lapId, request.idempotencyKey, "success", "remote-job-1", uploadedAt)).toBe(false);
    const upload = await readOnlineLapUpload(created.lapId);
    expect(upload).toMatchObject({ result: "success", remoteJobId: "remote-job-1", uploadedAt });
    expect((await getOnlineUploadWinnerPage(null, 250)).items).not.toContainEqual(expect.objectContaining({ lapId: created.lapId }));
    expect((await getOnlineLapUploadStatus(accountId)).lastSyncedAt).toBe(uploadedAt);
  } finally {
    await deleteSession(created.sessionId);
    if (previous) await db.update(onlineFastestLapInitialization).set({
      lastCheckedLapId: previous.lastCheckedLapId, complete: previous.complete,
    }).where(eq(onlineFastestLapInitialization.id, 1)).run();
  }
});

test("null winner lap reference retains old time until slower eligible capture replaces it", async () => {
  await ensureOwner();
  const trackId = `null-winner-${crypto.randomUUID()}`;
  const carId = `null-winner-car-${crypto.randomUUID()}`;
  const created: number[] = [];
  try {
    const old = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 80 });
    created.push(old.sessionId);
    await db.update(onlineFastestComboLaps).set({ lapId: null }).where(eq(onlineFastestComboLaps.lapId, old.lapId)).run();
    const slower = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 90 });
    created.push(slower.sessionId);
    expect(await db.select({ lapId: onlineFastestComboLaps.lapId, lapTimeMs: onlineFastestComboLaps.lapTimeMs })
      .from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.gameId, slower.gameId)).get())
      .toEqual({ lapId: slower.lapId, lapTimeMs: 90_000 });
  } finally {
    for (const sessionId of created) await deleteSession(sessionId);
  }
});

test("finalized completion is idempotent and rejects changed source window", async () => {
  await ensureOwner();
  const created = await addLap({ origin: "native_capture", provisional: true, time: 92, attribution: "Self" });
  const complete = (frames: number, time: number, domain: string) => updateCapturedLap(
    created.lapId, created.sessionId, 1, time, true, null, frames, null, null, null,
    [time / 3, time / 3, time / 3], null, undefined,
    { ...created.attribution!, source: { domain, startMs: 0, endMs: 10_000 } },
  );
  try {
    await complete(11, 92, created.attribution!.source.domain);
    const before = await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get();
    const winnerBefore = await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).get();
    await complete(11, 92, created.attribution!.source.domain);
    expect(await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get()).toEqual(before);
    expect(await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).get()).toEqual(winnerBefore);
    await expect(complete(12, 92, created.attribution!.source.domain)).rejects.toThrow("Finalized lap source window changed");
    expect(await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get()).toEqual(before);
    expect(await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).get()).toEqual(winnerBefore);
  } finally {
    await deleteSession(created.sessionId);
  }
});

test("initialization processes below-cursor provisional rows once and leaves state unchanged on rollback", async () => {
  await ensureOwner();
  const created = await addLap({ origin: "native_capture", provisional: true, time: 92, attribution: "Self" });
  const previous = await readDb.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
  try {
    await db.update(onlineFastestLapInitialization).set({ lastCheckedLapId: created.lapId, complete: false })
      .where(eq(onlineFastestLapInitialization.id, 1)).run();
    const complete = () => updateCapturedLap(created.lapId, created.sessionId, 1, 92, true, null, 11, null, null, null,
      [92 / 3, 92 / 3, 92 / 3], null, undefined, created.attribution);
    await complete();
    const evaluatedAt = (await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get())?.evaluatedAt;
    await complete();
    expect((await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get())?.evaluatedAt).toBe(evaluatedAt);
    expect(evaluatedAt).toBeTruthy();
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 0, complete: true });
    expect((await readOnlineLapUpload(created.lapId))?.lapId).toBe(created.lapId);
    await db.update(onlineFastestLapInitialization).set({ lastCheckedLapId: 0, complete: false })
      .where(eq(onlineFastestLapInitialization.id, 1)).run();
    const stateBefore = await db.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
    const markerBefore = await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get();
    const winnerBefore = await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).get();
    await expect(db.transaction(async (tx) => {
      await tx.update(onlineFastestLapInitialization).set({ lastCheckedLapId: created.lapId, complete: true })
        .where(eq(onlineFastestLapInitialization.id, 1)).run();
      await tx.update(laps).set({ onlineEvaluatedAt: null }).where(eq(laps.id, created.lapId)).run();
      await tx.delete(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).run();
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await db.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get()).toEqual(stateBefore);
    expect(await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, created.lapId)).get()).toEqual(markerBefore);
    expect(await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).get()).toEqual(winnerBefore);
  } finally {
    await deleteSession(created.sessionId);
    if (previous) await db.update(onlineFastestLapInitialization).set({
      lastCheckedLapId: previous.lastCheckedLapId, complete: previous.complete,
    }).where(eq(onlineFastestLapInitialization.id, 1)).run();
  }
});

test("malformed persisted stints are evaluated as Unknown during initialization", async () => {
  await ensureOwner();
  const created = await addLap({ origin: "native_capture", attribution: "Self", time: 88 });
  const previous = await readDb.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
  try {
    for (const stints of ["null", "{}", "{"]) {
      await db.delete(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, created.lapId)).run();
      await db.update(laps).set({ onlineEvaluatedAt: null, driverAttributionStints: sql`${stints}` })
        .where(eq(laps.id, created.lapId)).run();
      await db.update(onlineFastestLapInitialization).set({ lastCheckedLapId: created.lapId - 1, complete: false })
        .where(eq(onlineFastestLapInitialization.id, 1)).run();
      expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 1, complete: false });
      expect(await readOnlineLapUpload(created.lapId)).toBeNull();
    }
  } finally {
    await deleteSession(created.sessionId);
    if (previous) await db.update(onlineFastestLapInitialization).set({
      lastCheckedLapId: previous.lastCheckedLapId, complete: previous.complete,
    }).where(eq(onlineFastestLapInitialization.id, 1)).run();
  }
});

test("live winners beyond initialization cursor do not skip older rows; completed initialization stays complete", async () => {
  await ensureOwner();
  const trackId = `cursor-live-${crypto.randomUUID()}`;
  const carId = `cursor-live-car-${crypto.randomUUID()}`;
  const old = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 91 });
  const previous = await readDb.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
  let laterSessionId: number | undefined;
  try {
    await db.delete(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, old.lapId)).run();
    await db.update(laps).set({ onlineEvaluatedAt: null }).where(eq(laps.id, old.lapId)).run();
    await db.update(onlineFastestLapInitialization).set({ lastCheckedLapId: old.lapId - 1, complete: false })
      .where(eq(onlineFastestLapInitialization.id, 1)).run();
    const later = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 90 });
    laterSessionId = later.sessionId;
    const liveEvaluatedAt = (await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, later.lapId)).get())?.evaluatedAt;
    const liveWinner = await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, later.lapId)).get();
    expect((await readOnlineLapUpload(later.lapId))?.lapId).toBe(later.lapId);
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 1, complete: false });
    expect((await readOnlineLapUpload(later.lapId))?.lapId).toBe(later.lapId);
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 1, complete: false });
    expect((await db.select({ evaluatedAt: laps.onlineEvaluatedAt }).from(laps).where(eq(laps.id, later.lapId)).get())?.evaluatedAt)
      .toBe(liveEvaluatedAt);
    expect(await db.select().from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.lapId, later.lapId)).get()).toEqual(liveWinner);
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 0, complete: true });
    expect(await initializeOnlineFastestLapWinners(1)).toEqual({ processed: 0, complete: true });
  } finally {
    await deleteSession(old.sessionId);
    if (laterSessionId !== undefined) await deleteSession(laterSessionId);
    if (previous) await db.update(onlineFastestLapInitialization).set({
      lastCheckedLapId: previous.lastCheckedLapId, complete: previous.complete,
    }).where(eq(onlineFastestLapInitialization.id, 1)).run();
  }
});

test("deleting winner does not select slower eligible lap as fallback", async () => {
  await ensureOwner();
  const trackId = `delete-winner-${crypto.randomUUID()}`;
  const carId = `delete-winner-car-${crypto.randomUUID()}`;
  const created: number[] = [];
  try {
    const fast = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 89 });
    created.push(fast.sessionId);
    const slow = await addLap({ origin: "native_capture", attribution: "Self", trackId, carId, time: 90 });
    created.push(slow.sessionId);
    await deleteSession(fast.sessionId);
    created.splice(created.indexOf(fast.sessionId), 1);
    expect(await readOnlineLapUpload(slow.lapId)).toBeNull();
    const winners = await db.select({ lapId: onlineFastestComboLaps.lapId })
      .from(onlineFastestComboLaps).where(eq(onlineFastestComboLaps.gameId, slow.gameId)).all();
    expect(winners.some((row) => row.lapId === slow.lapId)).toBe(false);
  } finally {
    for (const sessionId of created) await deleteSession(sessionId);
  }
});
