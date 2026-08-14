import { afterEach, expect, test } from "bun:test";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../server/db";
import { getLapCountsByTest } from "../../server/db/experiment-version-queries";
import { analysisEligibility } from "../../server/db/lap-eligibility";
import { getSessionRecapData, getSessions } from "../../server/db/session-queries";
import { computeRecap } from "../../server/lap-analysis/recap";
import { experimentVersions, experiments, laps, sessions } from "../../server/db/schema";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type EligibilityStatus,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";

const createdSessionIds: number[] = [];
const createdExperimentIds: number[] = [];

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    await db.delete(laps).where(inArray(laps.sessionId, createdSessionIds)).run();
    await db.delete(sessions).where(inArray(sessions.id, createdSessionIds)).run();
    createdSessionIds.length = 0;
  }
  if (createdExperimentIds.length > 0) {
    await db.delete(experimentVersions).where(inArray(experimentVersions.experimentId, createdExperimentIds)).run();
    await db.delete(experiments).where(inArray(experiments.id, createdExperimentIds)).run();
    createdExperimentIds.length = 0;
  }
});
function normalPace(status: EligibilityStatus): EligibilityDecisionSet {
  return {
    "normal-pace": {
      status,
      policyId: "normal-pace",
      policyVersion: "1",
      confidence: { level: "high", score: 1 },
      reasons: [],
      evidenceIds: [],
    },
    "corner-trace": {
      status,
      policyId: "corner-trace",
      policyVersion: "1",
      confidence: { level: "high", score: 1 },
      reasons: [],
      evidenceIds: [],
    },
    "setup-analysis": {
      status,
      policyId: "setup-analysis",
      policyVersion: "1",
      confidence: { level: "high", score: 1 },
      reasons: [],
      evidenceIds: [],
    },
  } as unknown as EligibilityDecisionSet;
}

function currentQualityEvidence(generation = "sha256:session-query-quality") {
  return {
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: "sha256:session-query-source",
        outputGeneration: generation,
      },
    } as unknown as LapQualitySummary,
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
    qualityGeneration: generation,
  };
}

test("analysisEligibility filters the normal-pace policy decision", async () => {
  const sessionId = (await db.insert(sessions).values({ carOrdinal: 992_229, trackOrdinal: 993_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);
  const experimentId = (await db.insert(experiments).values({ gameId: "iracing", name: "pace eligibility test" }).returning({ id: experiments.id }).get()).id;
  createdExperimentIds.push(experimentId);
  const experimentVersionId = (await db.insert(experimentVersions).values({ experimentId, version: 1, label: "base" }).returning({ id: experimentVersions.id }).get()).id;
  const versionLink = { experimentId, experimentVersionId };

  const inserted = await db
    .insert(laps)
    .values([
      { ...versionLink, sessionId, lapNumber: 1, lapTime: 90_000, isValid: true, paceEligibility: "eligible", eligibility: normalPace("eligible") },
      { ...versionLink, sessionId, lapNumber: 2, lapTime: 89_000, isValid: true, phase: "out", paceEligibility: "excluded", eligibility: normalPace("ineligible") },
      { ...versionLink, sessionId, lapNumber: 3, lapTime: 88_000, isValid: true, conditions: ["caution"], paceEligibility: "excluded", eligibility: normalPace("ineligible") },
      { ...versionLink, sessionId, lapNumber: 4, lapTime: 87_000, isValid: false, paceEligibility: "eligible", eligibility: normalPace("eligible") },
      { ...versionLink, sessionId, lapNumber: 5, lapTime: 0, isValid: true, paceEligibility: "eligible", eligibility: normalPace("eligible") },
    ])
    .returning({ id: laps.id, lapNumber: laps.lapNumber })
    .all();
  const idByLapNumber = new Map(inserted.map((lap) => [lap.lapNumber, lap.id]));
  const eligibilityMatches = await db
    .select({ id: laps.id })
    .from(laps)
    .where(and(eq(laps.sessionId, sessionId), analysisEligibility(laps, "normal-pace")))
    .orderBy(laps.lapNumber)
    .all();
  expect(eligibilityMatches.map((lap) => lap.id)).toEqual([idByLapNumber.get(1)!, idByLapNumber.get(4)!, idByLapNumber.get(5)!]);

  const fullyEligible = await db
    .select({ id: laps.id })
    .from(laps)
    .where(and(eq(laps.sessionId, sessionId), analysisEligibility(laps, "normal-pace"), eq(laps.isValid, true), gt(laps.lapTime, 0)))
    .all();
  expect(fullyEligible.map((lap) => lap.id)).toEqual([idByLapNumber.get(1)!]);

  expect((await getLapCountsByTest(experimentId)).get(experimentVersionId)).toEqual({
    lapCount: 5,
    bestLapMs: null,
  });
});

test("experiment test best lap requires a setup-eligible group", async () => {
  const sessionId = (await db.insert(sessions).values({ carOrdinal: 996_229, trackOrdinal: 997_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);
  const experimentId = (await db.insert(experiments).values({ gameId: "iracing", name: "setup group eligibility test" }).returning({ id: experiments.id }).get()).id;
  createdExperimentIds.push(experimentId);
  const experimentVersionId = (await db.insert(experimentVersions).values({ experimentId, version: 1, label: "base" }).returning({ id: experimentVersions.id }).get()).id;
  const eligibility = normalPace("eligible");

  await db.insert(laps).values(
    [90_000, 90_500, 89_500].map((lapTime, index) => ({
      experimentId,
      experimentVersionId,
      sessionId,
      lapNumber: index + 1,
      lapTime,
      isValid: true,
      ...currentQualityEvidence(),
      eligibility,
    })),
  );

  expect((await getLapCountsByTest(experimentId)).get(experimentVersionId)).toEqual({
    lapCount: 3,
    bestLapMs: 89_500,
  });
});

test("session recap keeps validity and positive-time filters caller-owned", async () => {
  const currentSessionId = (await db.insert(sessions).values({ carOrdinal: 994_229, trackOrdinal: 995_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  const comparisonSessionId = (await db.insert(sessions).values({ carOrdinal: 994_229, trackOrdinal: 995_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(currentSessionId, comparisonSessionId);

  await db.insert(laps).values([
    {
      ...currentQualityEvidence(),
      sessionId: currentSessionId,
      lapNumber: 1,
      lapTime: 91_000,
      isValid: true,
      paceEligibility: "eligible",
      sectorTimes: [45_500, 45_500],
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence(),
      sessionId: comparisonSessionId,
      lapNumber: 1,
      lapTime: 90_000,
      isValid: true,
      paceEligibility: "eligible",
      sectorTimes: [45_000, 45_000],
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence(),
      sessionId: comparisonSessionId,
      lapNumber: 2,
      lapTime: 70_000,
      isValid: true,
      phase: "out",
      paceEligibility: "excluded",
      sectorTimes: [35_000, 35_000],
      eligibility: normalPace("ineligible"),
    },
    {
      ...currentQualityEvidence(),
      sessionId: comparisonSessionId,
      lapNumber: 3,
      lapTime: 71_000,
      isValid: true,
      conditions: ["caution"],
      paceEligibility: "excluded",
      sectorTimes: [35_500, 35_500],
      eligibility: normalPace("ineligible"),
    },
    {
      ...currentQualityEvidence(),
      sessionId: comparisonSessionId,
      lapNumber: 4,
      lapTime: 72_000,
      isValid: false,
      paceEligibility: "eligible",
      sectorTimes: [36_000, 36_000],
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence(),
      sessionId: comparisonSessionId,
      lapNumber: 5,
      lapTime: 0,
      isValid: true,
      paceEligibility: "eligible",
      sectorTimes: [1, 1],
      eligibility: normalPace("eligible"),
    },
  ]);

  const recap = await getSessionRecapData(currentSessionId, "iracing");
  expect(recap?.allTimeBestSec).toBe(90_000);
  expect(recap?.allTimeBestSectors).toEqual([45_000, 45_000]);
});

test("session recap excludes stale and legacy eligibility from cross-session pace", async () => {
  const currentSessionId = (
    await db.insert(sessions).values({ carOrdinal: 991_229, trackOrdinal: 990_229, gameId: "iracing" }).returning({ id: sessions.id }).get()
  ).id;
  const comparisonSessionId = (
    await db.insert(sessions).values({ carOrdinal: 991_229, trackOrdinal: 990_229, gameId: "iracing" }).returning({ id: sessions.id }).get()
  ).id;
  createdSessionIds.push(currentSessionId, comparisonSessionId);

  const staleColumnEvidence = [
    { ...currentQualityEvidence("sha256:cross-session-stale-output"), qualityGeneration: "sha256:cross-session-stale-column" },
    { ...currentQualityEvidence("sha256:cross-session-stale-schema"), qualitySchemaVersion: "legacy-schema" },
    { ...currentQualityEvidence("sha256:cross-session-stale-policy"), qualityPolicyVersion: "legacy-policy" },
    { ...currentQualityEvidence("sha256:cross-session-stale-config"), qualityConfigVersion: "legacy-config" },
  ];
  const staleProvenanceEvidence = (["schemaVersion", "policyVersion", "configurationVersion"] as const).map((field) => {
    const evidence = currentQualityEvidence(`sha256:cross-session-stale-provenance-${field}`);
    return {
      ...evidence,
      quality: {
        ...evidence.quality,
        provenance: { ...evidence.quality.provenance, [field]: `legacy-${field}` },
      } as LapQualitySummary,
    };
  });
  const staleRows = [...staleColumnEvidence, ...staleProvenanceEvidence].map((evidence, index) => ({
    ...evidence,
    sessionId: comparisonSessionId,
    lapNumber: index + 2,
    lapTime: 80_000 - index * 1_000,
    isValid: true,
    sectorTimes: [40_000 - index * 500, 40_000 - index * 500],
    eligibility: normalPace("eligible"),
  }));

  await db.insert(laps).values([
    {
      ...currentQualityEvidence("sha256:cross-session-anchor"),
      sessionId: currentSessionId,
      lapNumber: 1,
      lapTime: 91_000,
      isValid: true,
      sectorTimes: [45_500, 45_500],
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("sha256:cross-session-current"),
      sessionId: comparisonSessionId,
      lapNumber: 1,
      lapTime: 90_000,
      isValid: true,
      sectorTimes: [45_000, 45_000],
      eligibility: normalPace("eligible"),
    },
    ...staleRows,
    {
      sessionId: comparisonSessionId,
      lapNumber: staleRows.length + 2,
      lapTime: 70_000,
      isValid: true,
      sectorTimes: [35_000, 35_000],
      eligibility: normalPace("eligible"),
    },
  ]);

  const recap = await getSessionRecapData(currentSessionId, "iracing");
  expect(recap?.allTimeBestSec).toBe(90_000);
  expect(recap?.allTimeBestSectors).toEqual([45_000, 45_000]);
});

test("session query projections preserve current pace evidence and reject stale, missing, non-pace, and legacy rows", async () => {
  const sessionId = (
    await db.insert(sessions).values({ carOrdinal: 998_229, trackOrdinal: 999_229, gameId: "iracing" }).returning({ id: sessions.id }).get()
  ).id;
  createdSessionIds.push(sessionId);

  await db.insert(laps).values([
    {
      ...currentQualityEvidence("sha256:session-query-current"),
      sessionId,
      lapNumber: 1,
      lapTime: 95_000,
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("sha256:session-query-stale-output"),
      qualityGeneration: "sha256:session-query-stale-column",
      sessionId,
      lapNumber: 2,
      lapTime: 90_000,
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("sha256:session-query-stale-version"),
      qualityPolicyVersion: "legacy-policy",
      sessionId,
      lapNumber: 3,
      lapTime: 89_000,
      eligibility: normalPace("eligible"),
    },
    {
      sessionId,
      lapNumber: 4,
      lapTime: 88_000,
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("sha256:session-query-non-pace"),
      sessionId,
      lapNumber: 5,
      lapTime: 87_000,
      paceEligibility: "excluded",
      eligibility: normalPace("ineligible"),
    },
    {
      sessionId,
      lapNumber: 6,
      lapTime: 86_000,
      paceEligibility: "eligible",
    },
  ]);

  const session = (await getSessions("iracing")).find((row) => row.id === sessionId);
  expect(session?.bestLapTime).toBe(95_000);

  const recapData = await getSessionRecapData(sessionId, "iracing");
  if (!recapData) throw new Error("Expected recap query data");
  const currentLap = recapData.laps.find((lap) => lap.lapNumber === 1);
  if (!currentLap) throw new Error("Expected current lap projection");
  expect(currentLap).toMatchObject({
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
    qualityGeneration: "sha256:session-query-current",
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        outputGeneration: "sha256:session-query-current",
      },
    },
  });

  const recap = computeRecap({
    ...recapData,
    carName: "Query test car",
    trackName: "Query test track",
  });
  expect(recap.sparkline.find((lap) => lap.lapNumber === 1)).toMatchObject({
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
    qualityGeneration: "sha256:session-query-current",
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        outputGeneration: "sha256:session-query-current",
      },
    },
  });
  expect(recap.sparkline.find((lap) => lap.lapNumber === 2)?.qualityGeneration).toBe("sha256:session-query-stale-column");
  expect(recap.sparkline.find((lap) => lap.lapNumber === 4)).toMatchObject({
    quality: null,
    qualityGeneration: null,
    qualitySchemaVersion: null,
    qualityPolicyVersion: null,
    qualityConfigVersion: null,
  });
  expect(recap.lapsValid).toBe(1);
  expect(recap.bestLapSec).toBe(95_000);
  expect(recap.bestLapId).toBe(currentLap.id);
  expect(recap.timeOnTrackSec).toBe(95_000);
});
