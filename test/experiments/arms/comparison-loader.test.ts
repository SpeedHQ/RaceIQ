import { afterEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../server/db";
import { experimentVersions, experiments, laps, sessions } from "../../../server/db/schema";
import { loadArmComparison } from "../../../server/experiments/comparison/load";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../../shared/racing/quality/contracts";

const createdExperimentIds: number[] = [];
const createdSessionIds: number[] = [];

const generation = "sha256:comparison-loader-quality";
const quality = {
  lifecycleState: "exact",
  facts: [],
  provenance: {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    configurationVersion: QUALITY_CONFIG_VERSION,
    sourceGeneration: "sha256:comparison-loader-source",
    outputGeneration: generation,
  },
} as unknown as LapQualitySummary;
const eligibility = {
  "normal-pace": {
    policyId: "normal-pace",
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    status: "eligible",
    confidence: { level: "high", score: 1 },
    reasons: [],
    evidenceIds: [],
  },
  "corner-trace": {
    policyId: "corner-trace",
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    status: "eligible",
    confidence: { level: "high", score: 1 },
    reasons: [],
    evidenceIds: [],
  },
} as unknown as EligibilityDecisionSet;

const currentEvidence = {
  quality,
  eligibility,
  qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
  qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
  qualityConfigVersion: QUALITY_CONFIG_VERSION,
  qualityGeneration: generation,
};

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

test("loadArmComparison preserves current persisted evidence and rejects stale adapters", async () => {
  const experimentId = (await db.insert(experiments).values({ gameId: "iracing", name: "comparison loader evidence", trackOrdinal: 8_229_001 }).returning({ id: experiments.id }).get()).id;
  createdExperimentIds.push(experimentId);
  const versions = await db
    .insert(experimentVersions)
    .values([
      { experimentId, version: 1, label: "A" },
      { experimentId, version: 2, label: "B" },
    ])
    .returning({ id: experimentVersions.id })
    .all();
  const sessionId = (await db.insert(sessions).values({ gameId: "iracing", carOrdinal: 8_229_000, trackOrdinal: 8_229_001 }).returning({ id: sessions.id }).get()).id;
  createdSessionIds.push(sessionId);

  const rows = [
    ...[90_000, 90_100, 90_200].map((lapTime, index) => ({ experimentVersionId: versions[0]!.id, lapNumber: index + 1, lapTime })),
    ...[89_900, 90_000, 90_100].map((lapTime, index) => ({ experimentVersionId: versions[1]!.id, lapNumber: index + 4, lapTime })),
  ].map((row) => ({
    ...row,
    ...currentEvidence,
    experimentId,
    sessionId,
    isValid: true,
    phase: "flying" as const,
    conditions: [],
    paceEligibility: "eligible" as const,
  }));
  await db.insert(laps).values(rows).run();

  const current = await loadArmComparison(experimentId, versions[0]!.id, versions[1]!.id, "lapTimeSec", { bootstrapSamples: 50 });
  expect(current.a.n).toBeGreaterThan(0);
  expect(current.b.n).toBeGreaterThan(0);

  await db.update(laps).set({ qualityGeneration: "sha256:stale" }).where(eq(laps.sessionId, sessionId)).run();
  const stale = await loadArmComparison(experimentId, versions[0]!.id, versions[1]!.id, "lapTimeSec", { bootstrapSamples: 50 });
  expect(stale.a.n).toBe(0);
  expect(stale.b.n).toBe(0);
  expect(stale.a.droppedIneligible).toBe(3);
  expect(stale.b.droppedIneligible).toBe(3);
});
