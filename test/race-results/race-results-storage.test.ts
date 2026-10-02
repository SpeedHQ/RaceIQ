import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { insertSession } from "../../server/db/session-queries";
import { db } from "../../server/db";
import { laps } from "../../server/db/schema";
import { countStaleRaceResults, getSessionResult, getStaleRaceResultSessionIds, replacePitEvents, upsertSessionResult, type SessionResultInput } from "../../server/db/session-result-queries";
import { getRecentRaceResults } from "../../server/race-results/aggregates";
import { initServerGameAdapters } from "../../server/games/init";
import { RACE_RESULT_PROCESSOR_ID, backfillRaceResults, backfillStaleRaceResults, reconcileSessionResult } from "../../server/race-results/reconcile";
import { sessionRoutes } from "../../server/routes/session-routes";
import type { RaceResultEvidence, RaceResultProvenance } from "../../shared/racing/results/types";

const evidence: RaceResultEvidence = {
  fieldStatus: {
    sessionType: "direct",
    classification: "direct",
    finishingPosition: "direct",
    qualifyingPosition: "direct",
    isPodium: "derived",
    isFastestLap: "derived",
    pitEvents: "derived",
    tyreStrategy: "simplified",
    fuelStrategy: "unavailable",
  },
  conflicts: [],
};
const provenance: RaceResultProvenance = {
  catalogVersion: "catalog-7",
  catalogHash: "sha256:catalog",
  catalogSchemaVersion: "schema-2",
  parserVersion: "f1-parser-3",
  resolverVersion: "resolver-4",
  derivationId: "race-result-derivation",
  derivationVersion: "3",
  derivationCodeHash: "sha256:derivation",
  rawInput: { objectId: "session.bin", contentHash: "sha256:raw", byteOffset: 64, byteLength: 128 },
  canonicalInput: { sessionId: "session-1", firstSequence: 0, lastSequence: 10, contentHash: "sha256:canonical" },
  authorityPolicyId: "race-result-outcome-authority",
  authorityPolicyVersion: "1",
};

describe("persisted race result metadata", () => {
  test("upserts one result and replaces ordered pit events on rerun", async () => {
    const sessionId = await insertSession(99, 88, "f1-2025", "race");
    await db.insert(laps).values([
      { sessionId, lapNumber: 3, lapTime: 100, isValid: true },
      { sessionId, lapNumber: 4, lapTime: 140, isValid: true },
    ]);
    const input: SessionResultInput = {
      sessionId,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 2,
      qualifyingPosition: 5,
      isPodium: true,
      isFastestLap: false,
      pitCount: 2,
      tyreStrategy: { compounds: ["soft", "medium"] },
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    } satisfies SessionResultInput;
    const first = await upsertSessionResult(input);
    const second = await upsertSessionResult(input);
    expect(second.id).toBe(first.id);
    await replacePitEvents(first.id, [
      { sequence: 2, lapNumber: 8, elapsedSeconds: 80, durationSeconds: 2.1, service: "fuel", tyreChange: null, fuelAdded: 5, fuelBefore: 10, fuelAfter: 15, linkage: "linked", source: { test: true } },
      { sequence: 1, lapNumber: 3, elapsedSeconds: 30, durationSeconds: null, service: "tyres", tyreChange: { to: "medium" }, fuelAdded: null, fuelBefore: null, fuelAfter: null, linkage: "linked", source: { test: true } },
    ]);
    const result = await getSessionResult(sessionId, "f1-2025");
    expect(result?.id).toBe(first.id);
    expect(result?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(result?.events[1]?.fuelAdded).toBe(5);
    expect(result?.provenance).toEqual(provenance);
    const pitLaps = await db.select({ lapNumber: laps.lapNumber, isValid: laps.isValid, invalidReason: laps.invalidReason }).from(laps).where(eq(laps.sessionId, sessionId)).orderBy(laps.lapNumber).all();
    expect(pitLaps).toEqual([
      { lapNumber: 3, isValid: false, invalidReason: "inlap" },
      { lapNumber: 4, isValid: false, invalidReason: "outlap" },
    ]);
  });
  test("counts and lists only results from older processor versions", async () => {
    const staleSessionId = await insertSession(12, 13, "f1-2025", "race");
    const resultlessSessionId = await insertSession(12, 13, "f1-2025", "race");
    const currentSessionId = await insertSession(12, 13, "f1-2025", "race");
    const input = (sessionId: number, processorVersion: string): SessionResultInput => ({
      sessionId,
      processorVersion,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });
    await upsertSessionResult(input(staleSessionId, "race-result-v0"));
    await upsertSessionResult(input(currentSessionId, RACE_RESULT_PROCESSOR_ID));
    expect(await countStaleRaceResults(RACE_RESULT_PROCESSOR_ID)).toBeGreaterThanOrEqual(2);
    const staleIds = await getStaleRaceResultSessionIds(
      RACE_RESULT_PROCESSOR_ID,
    );
    expect(staleIds).toEqual(
      expect.arrayContaining([staleSessionId, resultlessSessionId]),
    );
    expect(staleIds).not.toContain(currentSessionId);
  });

  test("reconciles stale results through bulk endpoint", async () => {
    const sessionId = await insertSession(14, 15, "f1-2025", "race");
    const resultlessSessionId = await insertSession(16, 17, "f1-2025", "race");
    await upsertSessionResult({
      sessionId,
      processorVersion: "race-result-v0",
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });

    const response = await sessionRoutes.request("/api/race-results/reconcile-stale", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await getSessionResult(sessionId, "f1-2025"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
    expect((await getSessionResult(resultlessSessionId, "f1-2025"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
  });

  test("reconciles stored results from an older processor version", async () => {
    const sessionId = await insertSession(77, 66, "f1-2025", "race");
    await upsertSessionResult({
      sessionId,
      processorVersion: "race-result-v0",
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });
    await reconcileSessionResult(sessionId, "f1-2025");
    expect((await getSessionResult(sessionId, "f1-2025"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
  });

  test("backfills historical sessions across registered game adapters", async () => {
    initServerGameAdapters();
    const f1SessionId = await insertSession(1, 1, "f1-2025", "race");
    const accSessionId = await insertSession(1, 1, "acc", "race");

    await backfillRaceResults({
      gameId: "f1-2025",
      limit: 1,
      afterSessionId: f1SessionId - 1,
    });
    await backfillRaceResults({
      gameId: "acc",
      limit: 1,
      afterSessionId: accSessionId - 1,
    });

    expect(
      (await getSessionResult(f1SessionId, "f1-2025"))?.processorVersion,
    ).toBe(RACE_RESULT_PROCESSOR_ID);
    expect(
      (await getSessionResult(accSessionId, "acc"))?.processorVersion,
    ).toBe(RACE_RESULT_PROCESSOR_ID);
  });

  test("startup backfill skips results from the current processor", async () => {
    const sessionId = await insertSession(1, 1, "fm-2023", "race");
    await upsertSessionResult({
      sessionId,
      processorVersion: RACE_RESULT_PROCESSOR_ID,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });

    const report = await backfillStaleRaceResults({
      gameId: "fm-2023",
      limit: 1,
      afterSessionId: sessionId - 1,
    });

    expect(report.processed).toBe(0);
    expect(report.results).toEqual([]);
  });


  test("does not expose a result across game scope", async () => {
    const sessionId = await insertSession(99, 88, "acc", "race");
    await upsertSessionResult({
      sessionId,
      sessionType: "race",
      classification: "unknown",
      outcomeStatus: "unavailable",
      finishingPosition: null,
      qualifyingPosition: null,
      isPodium: null,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence: {
        ...evidence,
        fieldStatus: { ...evidence.fieldStatus, classification: "unavailable" },
      },
      reasons: ["unsupported"],
    });
    expect(await getSessionResult(sessionId, "f1-2025")).toBeNull();
  });
  test("returns newest persisted sessions without counting unpersisted gaps", async () => {
    const oldest = await insertSession(1, 1, "f1-2025", "race");
    await insertSession(1, 1, "f1-2025", "race");
    await insertSession(1, 1, "f1-2025", "race");
    await upsertSessionResult({
      sessionId: oldest,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });
    const results = await getRecentRaceResults("f1-2025", 2);
    expect(results[0]?.sessionId).toBe(oldest);
    expect(results.map((result) => result.sessionId)).not.toContain(oldest + 1);
    expect(results.map((result) => result.sessionId)).not.toContain(oldest + 2);
  });

});
