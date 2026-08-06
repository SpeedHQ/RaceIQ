import { afterEach, describe, expect, mock, test, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { sessions, sessionResults } from "../../server/db/schema";
import { insertSession } from "../../server/db/session-queries";
import { upsertSessionResult, type SessionResultInput } from "../../server/db/session-result-queries";
import { RACE_RESULT_PROCESSOR_ID } from "../../server/race-results/reconcile";
import { LAP_DETECTOR_ID } from "../../server/lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "../../server/games/acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "../../server/games/ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "../../server/games/iracing/lap-detector";
import { wsManager } from "../../server/runtime/websocket-manager";

mock.module("../../server/tunes/community-sync", () => ({ startCommunityTunesSync: () => {} }));
mock.module("../../server/sync/laptimes", () => ({ startLaptimesSync: () => {} }));
mock.module("../../server/session-capture/compressor", () => ({ startSessionCompressor: () => {} }));
mock.module("../../server/runtime/update/check", () => ({ startUpdateCheckSchedule: () => {} }));

const { startSyncAndStaleSessionJobs } = await import("../../server/runtime/startup-jobs");
const provenance = { test: true };
const evidence = { fieldStatus: {}, conflicts: [] };

async function waitForStartupChecks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function insertDetectorSession(rawFile: string | null, version: string | null) {
  return db.insert(sessions).values({ carOrdinal: 1, trackOrdinal: 1, gameId: "fm-2023", rawFile, lapDetectorVersion: version }).returning({ id: sessions.id }).get();
}

async function insertResult(sessionId: number, processorVersion: string) {
  const input: SessionResultInput = {
    sessionId, processorVersion, sessionType: "race", classification: "finished", outcomeStatus: "confirmed",
    finishingPosition: 1, qualifyingPosition: null, isPodium: true, isFastestLap: null, pitCount: 0,
    tyreStrategy: null, fuelStrategy: null, provenance, evidence, reasons: [],
  };
  await upsertSessionResult(input);
}

describe("startup stale-session notifications", () => {
  const sessionIds: number[] = [];
  let staleSessionsSpy: ReturnType<typeof spyOn>;
  let staleResultsSpy: ReturnType<typeof spyOn>;

  afterEach(async () => {
    staleSessionsSpy?.mockRestore();
    staleResultsSpy?.mockRestore();
    if (sessionIds.length) {
      for (const id of sessionIds) await db.delete(sessionResults).where(eq(sessionResults.sessionId, id)).run();
      for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id)).run();
      sessionIds.length = 0;
    }
  });

  test("publishes stale detector and race-result payloads with resultless rows", async () => {
    const oldRaw = await insertDetectorSession("old.bin", "old-detector");
    const nullRaw = await insertDetectorSession("null.bin", null);
    const currentDetector = await insertDetectorSession("current.bin", LAP_DETECTOR_ID);
    const noRaw = await insertDetectorSession(null, null);
    const oldResult = await insertSession(2, 3, "f1-2025", "race");
    const resultless = await insertSession(2, 4, "f1-2025", "race");
    const currentResult = await insertSession(2, 5, "f1-2025", "race");
    sessionIds.push(oldRaw.id, nullRaw.id, currentDetector.id, noRaw.id, oldResult, resultless, currentResult);
    await insertResult(oldRaw.id, RACE_RESULT_PROCESSOR_ID);
    await insertResult(nullRaw.id, RACE_RESULT_PROCESSOR_ID);
    await insertResult(noRaw.id, RACE_RESULT_PROCESSOR_ID);
    await insertResult(currentDetector.id, RACE_RESULT_PROCESSOR_ID);
    await insertResult(oldResult, "old-processor");
    await insertResult(currentResult, RACE_RESULT_PROCESSOR_ID);

    staleSessionsSpy = spyOn(wsManager, "setStaleSessionsNotification").mockImplementation(() => {});
    staleResultsSpy = spyOn(wsManager, "setStaleRaceResultsNotification").mockImplementation(() => {});
    startSyncAndStaleSessionJobs();
    await waitForStartupChecks();

    expect(staleSessionsSpy).toHaveBeenCalledWith({ type: "stale-lap-detection", sessionCount: 2, currentVersion: [LAP_DETECTOR_ID, LAP_DETECTOR_ACC_ID, LAP_DETECTOR_AC_EVO_ID, LAP_DETECTOR_IRACING_ID].join(",") });
    expect(staleResultsSpy).toHaveBeenCalledWith({ type: "stale-race-results", sessionCount: 2, currentVersion: RACE_RESULT_PROCESSOR_ID });
  });
  test("publishes no notification for all-current detector IDs and non-raw sessions", async () => {
    expect([LAP_DETECTOR_ID, LAP_DETECTOR_ACC_ID, LAP_DETECTOR_AC_EVO_ID, LAP_DETECTOR_IRACING_ID]).toEqual([
      LAP_DETECTOR_ID, LAP_DETECTOR_ACC_ID, LAP_DETECTOR_AC_EVO_ID, LAP_DETECTOR_IRACING_ID,
    ]);
    const currentDetector = await insertDetectorSession("current.bin", LAP_DETECTOR_ID);
    const noRaw = await insertDetectorSession(null, null);
    const currentResult = await insertSession(2, 6, "f1-2025", "race");
    sessionIds.push(currentDetector.id, noRaw.id, currentResult);
    await insertResult(currentDetector.id, RACE_RESULT_PROCESSOR_ID);
    await insertResult(noRaw.id, RACE_RESULT_PROCESSOR_ID);
    await insertResult(currentResult, RACE_RESULT_PROCESSOR_ID);

    staleSessionsSpy = spyOn(wsManager, "setStaleSessionsNotification").mockImplementation(() => {});
    staleResultsSpy = spyOn(wsManager, "setStaleRaceResultsNotification").mockImplementation(() => {});
    startSyncAndStaleSessionJobs();
    await waitForStartupChecks();

    expect(staleSessionsSpy).not.toHaveBeenCalled();
    expect(staleResultsSpy).not.toHaveBeenCalled();
  });

});
