import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { insertSession } from "../../server/db/session-queries";
import { db } from "../../server/db";
import { compareAnalyses, lapAnalyses, laps } from "../../server/db/schema";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { countStaleRaceResults, getSessionResult, getStaleRaceResultSessionIds, replacePitEvents, upsertSessionResult, type SessionResultInput } from "../../server/db/session-result-queries";
import { getRaceResultAggregate, getRecentRaceResults } from "../../server/race-results/aggregates";
import { initServerGameAdapters } from "../../server/games/init";
import { RACE_RESULT_PROCESSOR_ID, backfillRaceResults, backfillStaleRaceResults, reconcileSessionResult } from "../../server/race-results/reconcile";
import { sessionRoutes } from "../../server/routes/session-routes";
import type { RaceResultEvidence, RaceResultProvenance } from "../../shared/racing/results/types";
import type { LapCondition, LapPhase } from "../../shared/racing/laps/classification";
import type { EligibilityDecision, QualityReasonCode } from "../../shared/racing/quality/contracts";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

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
const qualityFixturePackets = qualityPackets(100);
function currentLapQuality(lapNumber: number, phase: LapPhase, conditions: LapCondition[]) {
  return finalizeLapQualityGeneration(
    summarize(qualityFixturePackets, {
      classification: { phase, conditions, paceEligibility: "excluded" },
    }),
    "legacy",
    {
      lapNumber,
      rawByteOffset: null,
      rawFrameCount: qualityFixturePackets.length,
    },
  );
}
function withOnlyReason(decision: EligibilityDecision, code: QualityReasonCode): EligibilityDecision {
  const reasons = decision.reasons.filter((reason) => reason.code === code);
  return {
    ...decision,
    reasons,
    evidenceIds: reasons.flatMap((reason) => reason.evidenceIds),
  };
}

describe("persisted race result metadata", () => {
  test("upserts one result and replaces ordered pit events on rerun", async () => {
    const expectedLap3Quality = currentLapQuality(3, "in", ["caution"]);
    const expectedLap4Quality = currentLapQuality(4, "out", ["slow_zone"]);
    const sessionId = await insertSession(99, 88, "f1-2025", "race");
    await db.insert(laps).values([
      {
        sessionId,
        lapNumber: 3,
        lapTime: 100,
        isValid: true,
        conditions: ["caution"],
        paceEligibility: "excluded",
        rawFrameCount: qualityFixturePackets.length,
        quality: expectedLap3Quality.quality,
        eligibility: {
          ...expectedLap3Quality.eligibility,
          "normal-pace": withOnlyReason(expectedLap3Quality.eligibility["normal-pace"], "caution_context"),
        },
        qualitySchemaVersion: expectedLap3Quality.quality.provenance.schemaVersion,
        qualityPolicyVersion: expectedLap3Quality.quality.provenance.policyVersion,
        qualityConfigVersion: expectedLap3Quality.quality.provenance.configurationVersion,
        qualityGeneration: expectedLap3Quality.quality.provenance.outputGeneration,
      },
      {
        sessionId,
        lapNumber: 4,
        lapTime: 140,
        isValid: true,
        conditions: ["slow_zone"],
        paceEligibility: "excluded",
        rawFrameCount: qualityFixturePackets.length,
        quality: expectedLap4Quality.quality,
        eligibility: {
          ...expectedLap4Quality.eligibility,
          "normal-pace": withOnlyReason(expectedLap4Quality.eligibility["normal-pace"], "non_pace_classification"),
        },
        qualitySchemaVersion: expectedLap4Quality.quality.provenance.schemaVersion,
        qualityPolicyVersion: expectedLap4Quality.quality.provenance.policyVersion,
        qualityConfigVersion: expectedLap4Quality.quality.provenance.configurationVersion,
        qualityGeneration: expectedLap4Quality.quality.provenance.outputGeneration,
      },
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
      {
        sequence: 2,
        lapNumber: 8,
        elapsedSeconds: 80,
        durationSeconds: 2.1,
        service: "fuel",
        tyreChange: null,
        fuelAdded: 5,
        fuelBefore: 10,
        fuelAfter: 15,
        linkage: "linked",
        source: { test: true },
      },
      {
        sequence: 1,
        lapNumber: 3,
        elapsedSeconds: 30,
        durationSeconds: null,
        service: "tyres",
        tyreChange: { to: "medium" },
        fuelAdded: null,
        fuelBefore: null,
        fuelAfter: null,
        linkage: "linked",
        source: { test: true },
      },
    ]);
    const result = await getSessionResult(sessionId, "f1-2025");
    expect(result?.id).toBe(first.id);
    expect(result?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(result?.events[1]?.fuelAdded).toBe(5);
    expect(result?.provenance).toEqual(provenance);
    expect(
      result?.lapQuality.map(({ lapNumber, qualityGeneration, officialTiming, normalPace }) => ({
        lapNumber,
        qualityGeneration,
        officialTiming: officialTiming.status,
        normalPace: normalPace.status,
        reasons: normalPace.reasons.map(({ code }) => code),
      })),
    ).toEqual([
      {
        lapNumber: 3,
        qualityGeneration: expectedLap3Quality.quality.provenance.outputGeneration,
        officialTiming: "eligible",
        normalPace: "ineligible",
        reasons: ["caution_context"],
      },
      {
        lapNumber: 4,
        qualityGeneration: expectedLap4Quality.quality.provenance.outputGeneration,
        officialTiming: "eligible",
        normalPace: "ineligible",
        reasons: ["non_pace_classification"],
      },
    ]);
    const aggregate = await getRaceResultAggregate({
      gameId: "f1-2025",
      carOrdinal: 99,
      trackOrdinal: 88,
    });
    expect(aggregate.lapQuality).toMatchObject({
      total: 2,
      officialTiming: {
        statuses: { eligible: 2, eligible_with_warning: 0, ineligible: 0, unknown: 0 },
      },
      normalPace: {
        statuses: { eligible: 0, eligible_with_warning: 0, ineligible: 2, unknown: 0 },
        reasons: { caution_context: 1, non_pace_classification: 1 },
      },
    });
    const pitLaps = await db
      .select({ lapNumber: laps.lapNumber, isValid: laps.isValid, phase: laps.phase, conditions: laps.conditions, paceEligibility: laps.paceEligibility, invalidReason: laps.invalidReason })
      .from(laps)
      .where(eq(laps.sessionId, sessionId))
      .orderBy(laps.lapNumber)
      .all();
    expect(pitLaps).toEqual([
      { lapNumber: 3, isValid: true, phase: "in", conditions: ["caution"], paceEligibility: "excluded", invalidReason: null },
      { lapNumber: 4, isValid: true, phase: "out", conditions: ["slow_zone"], paceEligibility: "excluded", invalidReason: null },
    ]);
  });
  test("regenerates pit-cycle quality and invalidates dependent analysis caches", async () => {
    const sessionId = await insertSession(199, 188, "f1-2025", "race");
    const packets = qualityPackets(100);
    const generatedByLap = [1, 2, 3, 4].map((lapNumber) =>
      finalizeLapQualityGeneration(summarize(packets), "legacy", {
        lapNumber,
        rawByteOffset: lapNumber * 1_000,
        rawFrameCount: packets.length,
      }),
    );
    const insertedLaps = await db
      .insert(laps)
      .values(
        generatedByLap.map((generated, index) => ({
          sessionId,
          lapNumber: index + 1,
          lapTime: 100 + index,
          isValid: true,
          rawByteOffset: (index + 1) * 1_000,
          rawFrameCount: packets.length,
          quality: generated.quality,
          eligibility: generated.eligibility,
          qualitySchemaVersion: generated.quality.provenance.schemaVersion,
          qualityPolicyVersion: generated.quality.provenance.policyVersion,
          qualityConfigVersion: generated.quality.provenance.configurationVersion,
          qualityGeneration: generated.quality.provenance.outputGeneration,
        })),
      )
      .returning({ id: laps.id, lapNumber: laps.lapNumber, qualityGeneration: laps.qualityGeneration })
      .all();
    const byLapNumber = new Map(insertedLaps.map((lap) => [lap.lapNumber, lap]));
    await db.insert(lapAnalyses).values(insertedLaps.map((lap) => ({ lapId: lap.id, analysis: `lap ${lap.lapNumber}` })));
    await db.insert(compareAnalyses).values([
      { lapAId: byLapNumber.get(1)!.id, lapBId: byLapNumber.get(3)!.id, kind: "inputs", analysis: "affected" },
      { lapAId: byLapNumber.get(3)!.id, lapBId: byLapNumber.get(4)!.id, kind: "inputs", analysis: "unaffected" },
    ]);
    const result = await upsertSessionResult({
      sessionId,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 4,
      qualifyingPosition: 6,
      isPodium: false,
      isFastestLap: false,
      pitCount: 1,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    });

    await replacePitEvents(result.id, [
      {
        sequence: 1,
        lapNumber: 1,
        elapsedSeconds: 100,
        durationSeconds: 20,
        service: "tyres",
        tyreChange: { to: "medium" },
        fuelAdded: null,
        fuelBefore: null,
        fuelAfter: null,
        linkage: "linked",
        source: { test: true },
      },
    ]);

    const storedLaps = await db
      .select({
        id: laps.id,
        lapNumber: laps.lapNumber,
        phase: laps.phase,
        paceEligibility: laps.paceEligibility,
        quality: laps.quality,
        eligibility: laps.eligibility,
        qualityGeneration: laps.qualityGeneration,
      })
      .from(laps)
      .where(eq(laps.sessionId, sessionId))
      .orderBy(laps.lapNumber)
      .all();
    for (const lapNumber of [1, 2]) {
      const stored = storedLaps.find((lap) => lap.lapNumber === lapNumber)!;
      expect(stored.phase).toBe(lapNumber === 1 ? "in" : "out");
      expect(stored.paceEligibility).toBe("excluded");
      expect(stored.quality?.classification).toMatchObject({
        phase: lapNumber === 1 ? "in" : "out",
        paceEligibility: "excluded",
      });
      expect(stored.eligibility?.["official-timing"].status).toBe("eligible");
      expect(stored.eligibility?.["normal-pace"]).toMatchObject({
        status: "ineligible",
        reasons: [expect.objectContaining({ code: "non_pace_classification" })],
      });
      expect(stored.qualityGeneration).not.toBe(byLapNumber.get(lapNumber)?.qualityGeneration);
      expect(stored.qualityGeneration).toBe(stored.quality!.provenance.outputGeneration);
    }
    for (const lapNumber of [3, 4]) {
      const stored = storedLaps.find((lap) => lap.lapNumber === lapNumber)!;
      expect(stored.qualityGeneration).toBe(byLapNumber.get(lapNumber)!.qualityGeneration);
      expect(stored.eligibility?.["normal-pace"].status).toBe("eligible");
    }

    const cachedLapIds = await db
      .select({ lapId: lapAnalyses.lapId })
      .from(lapAnalyses)
      .where(inArray(lapAnalyses.lapId, insertedLaps.map(({ id }) => id)))
      .orderBy(lapAnalyses.lapId)
      .all();
    expect(cachedLapIds.map(({ lapId }) => lapId)).toEqual([byLapNumber.get(3)!.id, byLapNumber.get(4)!.id]);
    const cachedComparisons = await db
      .select({ lapAId: compareAnalyses.lapAId, lapBId: compareAnalyses.lapBId })
      .from(compareAnalyses)
      .where(
        and(
          inArray(compareAnalyses.lapAId, insertedLaps.map(({ id }) => id)),
          inArray(compareAnalyses.lapBId, insertedLaps.map(({ id }) => id)),
        ),
      )
      .all();
    expect(cachedComparisons).toEqual([{ lapAId: byLapNumber.get(3)!.id, lapBId: byLapNumber.get(4)!.id }]);
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
    const staleIds = await getStaleRaceResultSessionIds(RACE_RESULT_PROCESSOR_ID);
    expect(staleIds).toEqual(expect.arrayContaining([staleSessionId, resultlessSessionId]));
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

    expect((await getSessionResult(f1SessionId, "f1-2025"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
    expect((await getSessionResult(accSessionId, "acc"))?.processorVersion).toBe(RACE_RESULT_PROCESSOR_ID);
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
