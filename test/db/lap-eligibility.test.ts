import { afterEach, expect, test } from "bun:test";
import { and, eq, gt, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../server/db";
import { getLapCountsByTest } from "../../server/db/experiment-version-queries";
import { analysisEligibility } from "../../server/db/lap-eligibility";
import { getLapById, getLaps } from "../../server/db/lap-read-queries";
import { getSessionRecapData, getSessions } from "../../server/db/session-queries";
import { computeRecap } from "../../server/lap-analysis/recap";
import { experimentVersions, experiments, laps, sessions } from "../../server/db/schema";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type EligibilityPolicyId,
  type EligibilityStatus,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent, resolveEligibilityDecision } from "../../shared/racing/quality/policies";

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

function qualityGeneration(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}
function normalPace(status: EligibilityStatus): EligibilityDecisionSet {
  const policyIds = [
    "official-timing",
    "normal-pace",
    "lap-comparison",
    "corner-trace",
    "transient-event",
    "fuel-burn",
    "tire-analysis",
    "stint-falloff",
    "setup-analysis",
    "driver-profile",
    "ml-training",
  ] as const satisfies readonly EligibilityPolicyId[];

  return Object.fromEntries(
    policyIds.map((policyId) => [
      policyId,
      {
        status,
        policyId,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        confidence: { level: "high", score: 1 },
        reasons: [],
        evidenceIds: [],
      },
    ]),
  ) as unknown as EligibilityDecisionSet;
}

function currentQualityEvidence(label = "session-query-quality") {
  const generation = qualityGeneration(label);
  return {
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        sourceGeneration: qualityGeneration("session-query-source"),
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

test("experiment best lap requires current persisted identity and a setup-eligible group", async () => {
  const sessionId = (await db.insert(sessions).values({ carOrdinal: 996_229, trackOrdinal: 997_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);
  const experimentId = (await db.insert(experiments).values({ gameId: "iracing", name: "setup group eligibility test" }).returning({ id: experiments.id }).get()).id;
  createdExperimentIds.push(experimentId);
  const experimentVersionId = (await db.insert(experimentVersions).values({ experimentId, version: 1, label: "base" }).returning({ id: experimentVersions.id }).get()).id;
  const staleVersionId = (await db.insert(experimentVersions).values({ experimentId, version: 2, label: "stale" }).returning({ id: experimentVersions.id }).get()).id;
  const eligibility = normalPace("eligible");

  await db.insert(laps).values(
    [90_000, 90_500, 89_500].map((lapTime, index) => ({
      experimentId,
      experimentVersionId,
      sessionId,
      lapNumber: index + 1,
      lapTime,
      isValid: true,
      ...currentQualityEvidence(`experiment-current-${index}`),
      eligibility,
    })),
  );
  const staleIdentityEvidence = [
    { ...currentQualityEvidence("experiment-stale-generation"), qualityGeneration: qualityGeneration("experiment-stale-column") },
    { ...currentQualityEvidence("experiment-stale-policy"), qualityPolicyVersion: "legacy-policy" },
    { ...currentQualityEvidence("experiment-stale-config"), qualityConfigVersion: "legacy-config" },
  ];
  await db.insert(laps).values(
    staleIdentityEvidence.map((evidence, index) => ({
      ...evidence,
      experimentId,
      experimentVersionId: staleVersionId,
      sessionId,
      lapNumber: index + 4,
      lapTime: 88_000 - index * 500,
      isValid: true,
      eligibility,
    })),
  );

  const counts = await getLapCountsByTest(experimentId);
  expect(counts.get(experimentVersionId)).toEqual({
    lapCount: 3,
    bestLapMs: 89_500,
  });
  expect(counts.get(staleVersionId)).toEqual({
    lapCount: 3,
    bestLapMs: null,
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

test("session recap and SQL eligibility exclude stale quality and decision identities", async () => {
  const currentSessionId = (await db.insert(sessions).values({ carOrdinal: 991_229, trackOrdinal: 990_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  const comparisonSessionId = (await db.insert(sessions).values({ carOrdinal: 991_229, trackOrdinal: 990_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(currentSessionId, comparisonSessionId);

  const staleColumnEvidence = [
    { ...currentQualityEvidence("cross-session-stale-output"), qualityGeneration: qualityGeneration("cross-session-stale-column") },
    { ...currentQualityEvidence("cross-session-stale-schema"), qualitySchemaVersion: "legacy-schema" },
    { ...currentQualityEvidence("cross-session-stale-policy"), qualityPolicyVersion: "legacy-policy" },
    { ...currentQualityEvidence("cross-session-stale-config"), qualityConfigVersion: "legacy-config" },
  ];
  const staleProvenanceEvidence = (["schemaVersion", "policyVersion", "configurationVersion"] as const).map((field) => {
    const evidence = currentQualityEvidence(`cross-session-stale-provenance-${field}`);
    return {
      ...evidence,
      quality: {
        ...evidence.quality,
        provenance: { ...evidence.quality.provenance, [field]: `legacy-${field}` },
      } as LapQualitySummary,
    };
  });
  const staleGenerationEvidence = (
    [
      ["sourceGeneration", "provisional"],
      ["outputGeneration", "provisional"],
      ["sourceGeneration", `sha256:${"A".repeat(64)}`],
      ["outputGeneration", `sha256:${"g".repeat(64)}`],
    ] as const
  ).map(([field, generation], index) => {
    const evidence = currentQualityEvidence(`cross-session-stale-generation-${index}`);
    return {
      ...evidence,
      quality: {
        ...evidence.quality,
        provenance: { ...evidence.quality.provenance, [field]: generation },
      } as LapQualitySummary,
      ...(field === "outputGeneration" ? { qualityGeneration: generation } : {}),
    };
  });
  const staleRows = [...staleColumnEvidence, ...staleProvenanceEvidence, ...staleGenerationEvidence].map((evidence, index) => ({
    ...evidence,
    sessionId: comparisonSessionId,
    lapNumber: index + 2,
    lapTime: 80_000 - index * 1_000,
    isValid: true,
    sectorTimes: [40_000 - index * 500, 40_000 - index * 500],
    eligibility: normalPace("eligible"),
  }));
  const staleDecisionVersion = normalPace("eligible");
  staleDecisionVersion["normal-pace"] = { ...staleDecisionVersion["normal-pace"], policyVersion: "legacy-policy" };
  const wrongDecisionPolicy = {
    ...normalPace("eligible"),
    "normal-pace": {
      ...normalPace("eligible")["normal-pace"],
      policyId: "corner-trace",
    },
  } as unknown as EligibilityDecisionSet;
  const decisionRows = [staleDecisionVersion, wrongDecisionPolicy].map((eligibility, index) => ({
    ...currentQualityEvidence(`cross-session-stale-decision-${index}`),
    sessionId: comparisonSessionId,
    lapNumber: staleRows.length + index + 2,
    lapTime: 68_000 - index * 1_000,
    isValid: true,
    sectorTimes: [34_000 - index * 500, 34_000 - index * 500],
    eligibility,
  }));

  await db.insert(laps).values([
    {
      ...currentQualityEvidence("cross-session-anchor"),
      sessionId: currentSessionId,
      lapNumber: 1,
      lapTime: 91_000,
      isValid: true,
      sectorTimes: [45_500, 45_500],
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("cross-session-current"),
      sessionId: comparisonSessionId,
      lapNumber: 1,
      lapTime: 90_000,
      isValid: true,
      sectorTimes: [45_000, 45_000],
      eligibility: normalPace("eligible"),
    },
    ...staleRows,
    ...decisionRows,
    {
      sessionId: comparisonSessionId,
      lapNumber: staleRows.length + decisionRows.length + 2,
      lapTime: 60_000,
      isValid: true,
      sectorTimes: [30_000, 30_000],
      eligibility: normalPace("eligible"),
    },
  ]);

  const directDecisionMatches = await db
    .select({ lapNumber: laps.lapNumber })
    .from(laps)
    .where(
      and(
        eq(laps.sessionId, comparisonSessionId),
        inArray(
          laps.lapNumber,
          decisionRows.map(({ lapNumber }) => lapNumber),
        ),
        analysisEligibility(laps, "normal-pace"),
      ),
    )
    .all();
  expect(directDecisionMatches).toEqual([]);

  const recap = await getSessionRecapData(currentSessionId, "iracing");
  expect(recap?.allTimeBestSec).toBe(90_000);
  expect(recap?.allTimeBestSectors).toEqual([45_000, 45_000]);
});

test("session query projections preserve current pace evidence and reject stale, missing, non-pace, and legacy rows", async () => {
  const sessionId = (await db.insert(sessions).values({ carOrdinal: 998_229, trackOrdinal: 999_229, gameId: "iracing" }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);

  await db.insert(laps).values([
    {
      ...currentQualityEvidence("session-query-current"),
      sessionId,
      lapNumber: 1,
      lapTime: 95_000,
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("session-query-stale-output"),
      qualityGeneration: qualityGeneration("session-query-stale-column"),
      sessionId,
      lapNumber: 2,
      lapTime: 90_000,
      eligibility: normalPace("eligible"),
    },
    {
      ...currentQualityEvidence("session-query-stale-version"),
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
      ...currentQualityEvidence("session-query-non-pace"),
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

  const projectedLaps = (await getLaps("iracing", 10_000)).filter((lap) => lap.sessionId === sessionId);
  const projectedLap = (lapNumber: number) => {
    const lap = projectedLaps.find((candidate) => candidate.lapNumber === lapNumber);
    if (!lap) throw new Error(`Expected projected lap ${lapNumber}`);
    return lap;
  };

  const currentLapMeta = projectedLap(1);
  const currentPersistedDecision = currentLapMeta.eligibility?.["normal-pace"];
  if (!currentPersistedDecision) throw new Error("Expected current persisted normal-pace decision");
  expect(currentLapMeta.qualityStale).toBe(false);
  expect(isEligibilitySnapshotCurrent(currentLapMeta)).toBe(true);
  expect(currentPersistedDecision).toBeDefined();
  expect(resolveEligibilityDecision(currentLapMeta, "normal-pace")).toBe(currentPersistedDecision);

  const staleLapMeta = projectedLap(2);
  const stalePersistedDecision = isEligibilitySnapshotCurrent(staleLapMeta) ? staleLapMeta.eligibility?.["normal-pace"] : undefined;
  expect(staleLapMeta.qualityStale).toBe(true);
  expect(stalePersistedDecision).toBeUndefined();
  const staleDecision = resolveEligibilityDecision(staleLapMeta, "normal-pace");
  expect(staleDecision.reasons.map(({ code }) => code)).toEqual(["quality_stale"]);
  expect(staleDecision).not.toBe(staleLapMeta.eligibility?.["normal-pace"]);

  const missingLapMeta = projectedLap(4);
  const missingPersistedDecision = isEligibilitySnapshotCurrent(missingLapMeta) ? missingLapMeta.eligibility?.["normal-pace"] : undefined;
  expect(missingLapMeta.qualityStale).toBe(false);
  expect(missingPersistedDecision).toBeUndefined();
  const missingDecision = resolveEligibilityDecision(missingLapMeta, "normal-pace");
  expect(missingDecision.reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);
  expect(missingDecision).not.toBe(missingLapMeta.eligibility?.["normal-pace"]);

  const fullMissingLap = await getLapById(missingLapMeta.id);
  if (!fullMissingLap) throw new Error("Expected full missing-quality lap");
  expect(fullMissingLap.qualityStale).toBe(false);
  expect(resolveEligibilityDecision(fullMissingLap, "normal-pace").reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);

  const fullStaleLap = await getLapById(staleLapMeta.id);
  if (!fullStaleLap) throw new Error("Expected full stale-quality lap");
  expect(fullStaleLap.qualityStale).toBe(true);
  expect(resolveEligibilityDecision(fullStaleLap, "normal-pace").reasons.map(({ code }) => code)).toEqual(["quality_stale"]);

  const recapData = await getSessionRecapData(sessionId, "iracing");
  if (!recapData) throw new Error("Expected recap query data");
  const currentLap = recapData.laps.find((lap) => lap.lapNumber === 1);
  if (!currentLap) throw new Error("Expected current lap projection");
  expect(currentLap).toMatchObject({
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
    qualityGeneration: qualityGeneration("session-query-current"),
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        outputGeneration: qualityGeneration("session-query-current"),
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
    qualityGeneration: qualityGeneration("session-query-current"),
    quality: {
      provenance: {
        schemaVersion: QUALITY_SCHEMA_VERSION,
        policyVersion: ELIGIBILITY_POLICY_VERSION,
        configurationVersion: QUALITY_CONFIG_VERSION,
        outputGeneration: qualityGeneration("session-query-current"),
      },
    },
  });
  expect(recap.sparkline.find((lap) => lap.lapNumber === 2)?.qualityGeneration).toBe(qualityGeneration("session-query-stale-column"));
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
