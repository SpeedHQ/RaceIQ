import { expect, test } from "bun:test";
import type { GameId } from "@raceiq/shared/games/ids";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { db } from "../../../db";
import { claimLocalAccountOwner, getLocalAccountOwner } from "../../../db/local-account-queries";
import { deleteSession, insertSession } from "../../../db/session-queries";
import { insertLap } from "../../../db/lap-mutation-queries";
import { laps, onlineFastestComboLaps } from "../../../db/schema";
import { initializeOnlineFastestLapWinners } from "../../../db/online-fastest-lap-queries";
import { readLapUploadItems, retainOnlineLapRequest, settleOnlineLapUpload } from "../../../db/online-upload-queries";
import { getRecordingInstallationId } from "../../../db/recording-origin";
import { eq, sql } from "drizzle-orm";

async function owner(): Promise<string> {
  const current = await getLocalAccountOwner();
  if (current) return current;
  const id = "online-fixture-owner-a";
  await claimLocalAccountOwner(id);
  return id;
}

async function lap(time: number, origin: "native_capture" | "portable_import" | "unknown" = "native_capture", ownership: "mine" | "others" = "mine") {
  const gameId = "acc" as GameId;
  const token = crypto.randomUUID();
  const sessionId = await insertSession(`status-car-${token}`, `status-track-${token}`, gameId, undefined, undefined, ownership,
    origin === "native_capture" ? { kind: origin } : origin === "portable_import" ? { kind: origin, originalActivityId: token } : { kind: origin });
  try {
    const source = `acc-fixture-${token}`;
    const clockDomain = `status-clock-${token}`;
    const bindingSnapshot = { id: `status-binding-${token}`, gameId, sourceKind: source,
      nativeIdentity: JSON.stringify({ schemaVersion: 1, actorId: "status-driver", bindingScope: "installation" }), confirmation: "user_confirmed" as const, revision: 1 };
    const actor = { gameId, source, actorId: "status-driver", bindingScope: "installation" as const, sessionId: String(sessionId), clockDomain, observedAtMs: 0 };
    const stints: DriverAttributionStint[] = [{ gameId, source, sessionId: String(sessionId), clockDomain, startMs: 0, endMs: 10_000,
      evidenceValidUntilMs: 10_000, actor, attribution: "Self", bindingRevision: 1, bindingSnapshot }];
    const attribution = origin === "native_capture" ? { stints, attribution: "Self" as const, source: { domain: clockDomain, startMs: 0, endMs: 10_000 } } : undefined;
    const lapId = await insertLap(sessionId, 1, time, true, null, 10, null, null, null, [time / 3, time / 3, time / 3], undefined, undefined, attribution);
    return { sessionId, lapId, gameId, token };
  } catch (error) {
    await deleteSession(sessionId);
    throw error;
  }
}


test("upload queue scans past malformed winner evidence across public cursors", async () => {
  const accountId = await owner();
  const fixtures: Awaited<ReturnType<typeof lap>>[] = [];
  try {
    const malformed = [await lap(81_000), await lap(82_000)];
    fixtures.push(...malformed);
    const eligible = [await lap(83_000), await lap(84_000)];
    fixtures.push(...eligible);
    await initializeOnlineFastestLapWinners(250);
    for (const fixture of malformed) await db.update(laps).set({ driverAttributionStints: sql`'[]'` }).where(eq(laps.id, fixture.lapId)).run();

    for (const limit of [1, 2]) {
      let cursor: { time: number; id: string } | null = null;
      const observed: string[] = [];
      while (true) {
        const page = await readLapUploadItems(accountId, "queue", cursor, limit);
        if (page.length === 0) break;
        observed.push(...page.map(item => item.id));
        const last = page.at(-1)!;
        cursor = { time: Date.parse(last.admittedAt), id: last.id };
      }
      expect(observed).toEqual(eligible.map(fixture => `lap:${fixture.lapId}`));
      for (const item of await readLapUploadItems(accountId, "queue", null, 101)) {
        expect(item).toMatchObject({ attemptCount: null, nextAttemptAt: null, acceptedAt: null, remoteJobId: null, validation: "not_requested", publication: "not_requested", settledAt: null });
      }
    }
  } finally {
    for (const fixture of fixtures) await deleteSession(fixture.sessionId);
  }
});
test("upload queue and history return stable, account-scoped native lap rows", async () => {
  const accountId = await owner();
  const fixtures: Awaited<ReturnType<typeof lap>>[] = [];
  try {
    const first = await lap(91_000); fixtures.push(first);
    const second = await lap(92_000); fixtures.push(second);
    const accepted = await lap(93_000); fixtures.push(accepted);
    const imported = await lap(70_000, "portable_import"); fixtures.push(imported);
    const foreign = await lap(71_000, "native_capture", "others"); fixtures.push(foreign);
    const unknown = await lap(72_000, "unknown"); fixtures.push(unknown);
    await initializeOnlineFastestLapWinners(250);

    const winnerRows = await db.select({ lapId: onlineFastestComboLaps.lapId }).from(onlineFastestComboLaps).all();
    expect(winnerRows.some(row => row.lapId === first.lapId)).toBe(true);
    expect(winnerRows.some(row => row.lapId === second.lapId)).toBe(true);
    expect(winnerRows.some(row => [imported.lapId, foreign.lapId, unknown.lapId].includes(row.lapId!))).toBe(false);

    const queue = await readLapUploadItems(accountId, "queue", null, 101);
    const expectedIds = [`lap:${first.lapId}`, `lap:${second.lapId}`, `lap:${accepted.lapId}`].sort((a, b) => a.localeCompare(b));
    const selected = queue.filter(item => expectedIds.includes(item.id));
    expect(selected.map(item => item.id).sort()).toEqual(expectedIds.sort());
    // Bun's matcher can mutate the received DTO; copy before matching so cursor dates remain ISO strings.
    for (const item of selected) expect({ ...item }).toMatchObject({ kind: "lap", delivery: "awaiting", validation: "not_requested", publication: "not_requested", attemptCount: null, admittedAt: expect.any(String), updatedAt: expect.any(String), settledAt: null });
    expect(queue.some(item => [imported.lapId, foreign.lapId, unknown.lapId].includes(item.lapId!))).toBe(false);

    const ordered = selected.slice().sort((a, b) => Date.parse(a.admittedAt) - Date.parse(b.admittedAt) || a.id.localeCompare(b.id));
    const selectedAdmittedAt = ordered[0]!.admittedAt;
    const cursor = { time: Date.parse(selectedAdmittedAt), id: ordered[0]!.id };
    const after = await readLapUploadItems(accountId, "queue", cursor, 101);
    expect(after.some(item => item.id === cursor.id)).toBe(false);
    expect(after.filter(item => expectedIds.includes(item.id)).map(item => item.id)).toEqual(ordered.slice(1).map(item => item.id));
    expect(await readLapUploadItems(`${accountId}-wrong`, "queue", null, 101)).toEqual([]);

    const request = { accountId, idempotencyKey: `status-${accepted.token}`, identityJson: "{}", payloadFingerprint: `fingerprint-${accepted.token}` };
    expect(await retainOnlineLapRequest(accepted.lapId, request)).toBe(true);
    expect(await settleOnlineLapUpload(accepted.lapId, request.idempotencyKey, "success", `job-${accepted.token}`, new Date().toISOString())).toBe(true);
    const remainingQueue = await readLapUploadItems(accountId, "queue", null, 101);
    expect(remainingQueue.some(item => item.id === `lap:${accepted.lapId}`)).toBe(false);
    const history = await readLapUploadItems(accountId, "history", null, 101);
    expect(history.find(item => item.id === `lap:${accepted.lapId}`)).toMatchObject({ delivery: "accepted", acceptedAt: expect.any(String), remoteJobId: `job-${accepted.token}`, validation: "unavailable", publication: "unavailable" });
    await deleteSession(first.sessionId);
    fixtures.splice(fixtures.indexOf(first), 1);
    expect((await readLapUploadItems(accountId, "queue", null, 101)).some(item => item.id === `lap:${first.lapId}`)).toBe(false);
    expect(getRecordingInstallationId()).toBeTruthy();
  } finally {
    for (const fixture of fixtures) await deleteSession(fixture.sessionId);
  }
});
