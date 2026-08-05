import { describe, expect, test } from "bun:test";
import { insertSession, getSessionResult, replacePitEvents, upsertSessionResult } from "../server/db/queries";
import { getRecentRaceResults } from "../server/race-results/aggregates";
import { initServerGameAdapters } from "../server/games/init";
import { RACE_RESULT_PROCESSOR_ID, backfillAllRaceResults, reconcileSessionResult } from "../server/race-results/reconcile";


describe("persisted race result metadata", () => {
  test("upserts one result and replaces ordered pit events on rerun", async () => {
    const sessionId = await insertSession(99, 88, "f1-2025", "race");
    const input = {
      sessionId,
      sessionType: "race",
      classification: "finished",
      finishingPosition: 2,
      qualifyingPosition: 5,
      isPodium: true,
      isFastestLap: false,
      pitCount: 2,
      tyreStrategy: { compounds: ["soft", "medium"] },
      fuelStrategy: null,
      provenance: { finishingPosition: "f1.grid" },
      reasons: [],
      processorVersion: RACE_RESULT_PROCESSOR_ID,
    } as const;
    const first = await upsertSessionResult(input);
    const second = await upsertSessionResult(input);
    await replacePitEvents(first.id, [
      { sequence: 2, lapNumber: 8, elapsedSeconds: 80, durationSeconds: 2.1, service: "fuel", tyreChange: null, fuelAdded: 5, fuelBefore: 10, fuelAfter: 15, linkage: "linked", source: { test: true } },
      { sequence: 1, lapNumber: 3, elapsedSeconds: 30, durationSeconds: null, service: "tyres", tyreChange: { to: "medium" }, fuelAdded: null, fuelBefore: null, fuelAfter: null, linkage: "linked", source: { test: true } },
    ]);
    const result = await getSessionResult(sessionId, "f1-2025");
    expect(result?.id).toBe(first.id);
    expect(result?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(result?.events[1]?.fuelAdded).toBe(5);
  });

  test("reconciles stored results from an older processor version", async () => {
    const sessionId = await insertSession(77, 66, "f1-2025", "race");
    await upsertSessionResult({
      sessionId,
      processorVersion: "race-result-v0",
      sessionType: "race",
      classification: "finished",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance: {},
      reasons: [],
    });
    await reconcileSessionResult(sessionId, "f1-2025");
    expect((await getSessionResult(sessionId, "f1-2025"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
  });

  test("does not expose a result across game scope", async () => {
    const sessionId = await insertSession(99, 88, "acc", "race");
    await upsertSessionResult({
      sessionId,
      sessionType: "race",
      classification: "unknown",
      finishingPosition: null,
      qualifyingPosition: null,
      isPodium: null,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance: {},
      reasons: ["unsupported"],
    });
    expect(await getSessionResult(sessionId, "f1-2025")).toBeNull();
  });
  test("returns only persisted sessions without reconciling gaps on read", async () => {
    const oldest = await insertSession(1, 1, "f1-2025", "race");
    await insertSession(1, 1, "f1-2025", "race");
    await insertSession(1, 1, "f1-2025", "race");
    await upsertSessionResult({
      sessionId: oldest,
      sessionType: "race",
      classification: "finished",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance: {},
      reasons: [],
    });
    const results = await getRecentRaceResults("f1-2025", 2);
    expect(results.some((result) => result.sessionId === oldest + 1 || result.sessionId === oldest + 2)).toBe(false);
    expect(await getSessionResult(oldest + 1, "f1-2025")).toBeNull();
    expect(await getSessionResult(oldest + 2, "f1-2025")).toBeNull();
  });

  test("backfills historical sessions across all registered games", async () => {
    initServerGameAdapters();
    const f1SessionId = await insertSession(1, 1, "f1-2025", "race");
    const accSessionId = await insertSession(1, 1, "acc", "race");

    await backfillAllRaceResults();

    expect((await getSessionResult(f1SessionId, "f1-2025"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
    expect((await getSessionResult(accSessionId, "acc"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
  });

});
