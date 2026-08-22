import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";

import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { FINDING_SCHEMA_VERSION } from "../../shared/racing/findings/types";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import {
  getAnalysis,
  getCompareAnalysis,
  qualityCacheIdentityForComparison,
  qualityCacheIdentityForLap,
  saveAnalysis,
  saveCompareAnalysis,
  type AnalysisUsage,
} from "../../server/db/analysis-queries";
import { db } from "../../server/db";
import {
  createFindingGenerationReceipt,
  replaceFindingGeneration,
  type FindingGenerationExpectation,
} from "../../server/findings/store";
import { compareAnalyses, lapAnalyses, laps, sessions } from "../../server/db/schema";
import { combineQualityGenerations } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

const createdSessionIds: number[] = [];
const createdLapIds: number[] = [];

const usage: AnalysisUsage = {
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0,
  durationMs: 30,
  model: "race-test-model",
};


function qualityGeneration(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

async function seedCurrentFindingGeneration(sessionId: number, lapId: number): Promise<FindingGenerationExpectation> {
  const scope = {
    kind: "lap" as const,
    gameId: "iracing" as const,
    sessionId: String(sessionId),
    lapId: String(lapId),
  };
  const generationId = `analysis-quality-finding:${lapId}`;
  const receipt = await replaceFindingGeneration({
    scope,
    receipt: createFindingGenerationReceipt({
      generationId,
      sourceId: generationId,
      rule: { id: "analysis-quality-test", version: "1" },
      config: { fixture: "analysis-quality-generation" },
      schemaVersion: FINDING_SCHEMA_VERSION,
      createdAt: "2026-01-01T00:00:00.000Z",
    }, []),
    findings: [],
  });
  return { scope, generationId: receipt.generationId, contentHash: receipt.contentHash };
}
function currentQuality(generation: string): LapQualitySummary {
  const quality = summarize(qualityPackets(100));
  return {
    ...quality,
    provenance: {
      ...quality.provenance,
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: qualityGeneration("analysis-quality-source"),
      outputGeneration: generation,
    },
  };
}

function currentEvidence(generation: string) {
  const quality = currentQuality(generation);
  return {
    quality,
    eligibility: evaluateAllEligibility(quality),
    qualityGeneration: generation,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
    qualityConfigVersion: QUALITY_CONFIG_VERSION,
  };
}

type CreatedLaps = {
  ids: number[];
  findingExpectations: FindingGenerationExpectation[];
};

async function createLaps(generations: readonly string[]): Promise<CreatedLaps> {
  const sessionId = (
    await db
      .insert(sessions)
      .values({
        carOrdinal: 9_231_001,
        trackOrdinal: 9_231_002,
        gameId: "iracing",
        source: "native-live",
      })
      .returning({ id: sessions.id })
      .get()
  ).id;
  createdSessionIds.push(sessionId);

  const ids: number[] = [];
  const findingExpectations: FindingGenerationExpectation[] = [];
  for (const [index, generation] of generations.entries()) {
    const lapId = (
      await db
        .insert(laps)
        .values({
          sessionId,
          lapNumber: index + 1,
          lapTime: 90 + index,
          isValid: true,
          ...currentEvidence(generation),
        })
        .returning({ id: laps.id })
        .get()
    ).id;
    ids.push(lapId);
    findingExpectations.push(await seedCurrentFindingGeneration(sessionId, lapId));
    createdLapIds.push(lapId);
  }
  return { ids, findingExpectations };
}

async function finishModelWork(changeIdentity: () => Promise<void>, output: string): Promise<string> {
  await changeIdentity();
  return output;
}

afterEach(async () => {
  if (createdLapIds.length > 0) {
    await db.delete(compareAnalyses).where(inArray(compareAnalyses.lapAId, createdLapIds)).run();
    await db.delete(compareAnalyses).where(inArray(compareAnalyses.lapBId, createdLapIds)).run();
  }
  for (const sessionId of createdSessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdLapIds.length = 0;
  createdSessionIds.length = 0;
});

describe("AI analysis quality generation races", () => {
  test("single-lap output generated from stale quality is neither cached nor stamped current", async () => {
    const originalGeneration = qualityGeneration("single-prompt");
    const currentGeneration = qualityGeneration("single-current");
    const created = await createLaps([originalGeneration]);
    const lapId = created.ids[0];
    const findingExpectation = created.findingExpectations[0];
    const expectedIdentity = qualityCacheIdentityForLap(currentEvidence(originalGeneration));
    if (lapId === undefined || findingExpectation === undefined || !expectedIdentity) {
      throw new Error("Expected single-lap quality and finding identities");
    }
    expect(await saveAnalysis(lapId, "existing analysis", usage, expectedIdentity, findingExpectation)).toBe(true);

    const staleOutput = await finishModelWork(async () => {
      await db.update(laps).set({ qualityGeneration: currentGeneration }).where(eq(laps.id, lapId)).run();
    }, "stale model output");
    const saved = await saveAnalysis(lapId, staleOutput, usage, expectedIdentity, findingExpectation);

    expect(saved).toBe(false);
    expect(await getAnalysis(lapId, findingExpectation)).toBeNull();
    const stored = await db
      .select({ analysis: lapAnalyses.analysis, qualityGeneration: lapAnalyses.qualityGeneration })
      .from(lapAnalyses)
      .where(eq(lapAnalyses.lapId, lapId))
      .get();
    expect(stored).toEqual({
      analysis: "existing analysis",
      qualityGeneration: originalGeneration,
    });
  });

  test("comparison output generated from stale quality is neither cached nor stamped current", async () => {
    const originalGenerations = [qualityGeneration("compare-a"), qualityGeneration("compare-b")] as const;
    const created = await createLaps(originalGenerations);
    const lapAId = created.ids[0];
    const lapBId = created.ids[1];
    const findingExpectationA = created.findingExpectations[0];
    const findingExpectationB = created.findingExpectations[1];
    const expectedIdentity = qualityCacheIdentityForComparison([currentEvidence(originalGenerations[0]), currentEvidence(originalGenerations[1])]);
    if (
      lapAId === undefined ||
      lapBId === undefined ||
      findingExpectationA === undefined ||
      findingExpectationB === undefined ||
      !expectedIdentity
    ) {
      throw new Error("Expected comparison quality and finding identities");
    }
    const findingExpectations: readonly [FindingGenerationExpectation, FindingGenerationExpectation] = [findingExpectationA, findingExpectationB];
    expect(await saveCompareAnalysis(lapAId, lapBId, "existing comparison", usage, expectedIdentity, findingExpectations, "inputs")).toBe(true);

    const staleOutput = await finishModelWork(async () => {
      await db.update(laps).set({ qualityGeneration: qualityGeneration("compare-a-current") }).where(eq(laps.id, lapAId)).run();
    }, "stale comparison output");
    const saved = await saveCompareAnalysis(lapAId, lapBId, staleOutput, usage, expectedIdentity, findingExpectations, "inputs");

    expect(saved).toBe(false);
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).toBeNull();
    const [lo, hi] = [lapAId, lapBId].sort((left, right) => left - right);
    const stored = await db
      .select({ analysis: compareAnalyses.analysis, qualityGeneration: compareAnalyses.qualityGeneration })
      .from(compareAnalyses)
      .where(
        and(
          eq(compareAnalyses.lapAId, lo!),
          eq(compareAnalyses.lapBId, hi!),
          eq(compareAnalyses.kind, "inputs"),
        ),
      )
      .get();
    expect(stored).toEqual({
      analysis: "existing comparison",
      qualityGeneration: expectedIdentity.generation,
    });
  });

  test("cache reads reject stale quality metadata even when cache generation still matches", async () => {
    const generations = [qualityGeneration("stale-cache-a"), qualityGeneration("stale-cache-b")] as const;
    const created = await createLaps(generations);
    const lapAId = created.ids[0];
    const lapBId = created.ids[1];
    const findingExpectationA = created.findingExpectations[0];
    const findingExpectationB = created.findingExpectations[1];
    const lapIdentity = qualityCacheIdentityForLap(currentEvidence(generations[0]));
    const comparisonIdentity = qualityCacheIdentityForComparison([currentEvidence(generations[0]), currentEvidence(generations[1])]);
    if (
      lapAId === undefined ||
      lapBId === undefined ||
      findingExpectationA === undefined ||
      findingExpectationB === undefined ||
      !lapIdentity ||
      !comparisonIdentity
    ) {
      throw new Error("Expected current quality and finding identities");
    }
    const findingExpectations: readonly [FindingGenerationExpectation, FindingGenerationExpectation] = [findingExpectationA, findingExpectationB];
    expect(await saveAnalysis(lapAId, "stale single analysis", usage, lapIdentity, findingExpectationA)).toBe(true);
    expect(await saveCompareAnalysis(lapAId, lapBId, "stale comparison", usage, comparisonIdentity, findingExpectations, "inputs")).toBe(true);

    await db.update(laps).set({ qualityConfigVersion: "stale-config" }).where(eq(laps.id, lapAId)).run();

    expect(await getAnalysis(lapAId, findingExpectationA)).toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).toBeNull();
  });

  test("cache reads and writes reject missing, stale-decision, and provisional evidence with matching metadata", async () => {
    const generations = [qualityGeneration("decision-cache-a"), qualityGeneration("decision-cache-b")] as const;
    const created = await createLaps(generations);
    const lapAId = created.ids[0];
    const lapBId = created.ids[1];
    const findingExpectationA = created.findingExpectations[0];
    const findingExpectationB = created.findingExpectations[1];
    const lapIdentity = qualityCacheIdentityForLap(currentEvidence(generations[0]));
    const comparisonIdentity = qualityCacheIdentityForComparison([currentEvidence(generations[0]), currentEvidence(generations[1])]);
    if (
      lapAId === undefined ||
      lapBId === undefined ||
      findingExpectationA === undefined ||
      findingExpectationB === undefined ||
      !lapIdentity ||
      !comparisonIdentity
    ) {
      throw new Error("Expected current quality and finding identities");
    }
    const findingExpectations: readonly [FindingGenerationExpectation, FindingGenerationExpectation] = [findingExpectationA, findingExpectationB];
    expect(await saveAnalysis(lapAId, "current single", usage, lapIdentity, findingExpectationA)).toBe(true);
    expect(await saveCompareAnalysis(lapAId, lapBId, "current comparison", usage, comparisonIdentity, findingExpectations, "inputs")).toBe(true);

    expect(qualityCacheIdentityForLap({ ...currentEvidence(generations[0]), eligibility: null })).toBeNull();
    expect(qualityCacheIdentityForComparison([{ ...currentEvidence(generations[0]), eligibility: null }, currentEvidence(generations[1])])).toBeNull();
    await db.update(laps).set({ eligibility: null }).where(eq(laps.id, lapAId)).run();
    expect(await getAnalysis(lapAId, findingExpectationA)).toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).toBeNull();
    expect(await saveAnalysis(lapAId, "missing decision", usage, lapIdentity, findingExpectationA)).toBe(false);
    expect(await saveCompareAnalysis(lapAId, lapBId, "missing decision", usage, comparisonIdentity, findingExpectations, "inputs")).toBe(false);

    const staleEligibility = evaluateAllEligibility(currentQuality(generations[0]));
    staleEligibility["normal-pace"] = { ...staleEligibility["normal-pace"], policyVersion: "legacy-policy" };
    expect(qualityCacheIdentityForLap({ ...currentEvidence(generations[0]), eligibility: staleEligibility })).toBeNull();
    expect(qualityCacheIdentityForComparison([{ ...currentEvidence(generations[0]), eligibility: staleEligibility }, currentEvidence(generations[1])])).toBeNull();
    await db.update(laps).set({ eligibility: staleEligibility as EligibilityDecisionSet }).where(eq(laps.id, lapAId)).run();
    expect(await getAnalysis(lapAId, findingExpectationA)).toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).toBeNull();
    expect(await saveAnalysis(lapAId, "stale decision", usage, lapIdentity, findingExpectationA)).toBe(false);
    expect(await saveCompareAnalysis(lapAId, lapBId, "stale decision", usage, comparisonIdentity, findingExpectations, "inputs")).toBe(false);

    const provisionalQuality = {
      ...currentQuality("provisional"),
      provenance: {
        ...currentQuality("provisional").provenance,
        sourceGeneration: "provisional",
        outputGeneration: "provisional",
      },
    } as LapQualitySummary;
    const provisionalEvidence = {
      quality: provisionalQuality,
      eligibility: evaluateAllEligibility(provisionalQuality),
      qualityGeneration: "provisional",
      qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
      qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
      qualityConfigVersion: QUALITY_CONFIG_VERSION,
    };
    expect(qualityCacheIdentityForLap(provisionalEvidence)).toBeNull();
    expect(qualityCacheIdentityForComparison([provisionalEvidence, currentEvidence(generations[1])])).toBeNull();
    await db.update(laps).set(provisionalEvidence).where(eq(laps.id, lapAId)).run();
    const provisionalComparisonGeneration = combineQualityGenerations(["provisional", generations[1]]);
    await db.update(lapAnalyses).set({ qualityGeneration: "provisional" }).where(eq(lapAnalyses.lapId, lapAId)).run();
    await db
      .update(compareAnalyses)
      .set({ qualityGeneration: provisionalComparisonGeneration })
      .where(and(eq(compareAnalyses.lapAId, Math.min(lapAId, lapBId)), eq(compareAnalyses.lapBId, Math.max(lapAId, lapBId)), eq(compareAnalyses.kind, "inputs")))
      .run();

    const provisionalIdentity = { generation: "provisional", policyVersion: ELIGIBILITY_POLICY_VERSION };
    const provisionalComparisonIdentity = { generation: provisionalComparisonGeneration, policyVersion: ELIGIBILITY_POLICY_VERSION };
    expect(await getAnalysis(lapAId, findingExpectationA)).toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).toBeNull();
    expect(await saveAnalysis(lapAId, "provisional", usage, provisionalIdentity, findingExpectationA)).toBe(false);
    expect(await saveCompareAnalysis(lapAId, lapBId, "provisional", usage, provisionalComparisonIdentity, findingExpectations, "inputs")).toBe(false);
  });

  test("finding-generation expectations require same current non-null receipt and ordered comparison pair", async () => {
    const generations = [qualityGeneration("fence-a"), qualityGeneration("fence-b")] as const;
    const created = await createLaps(generations);
    const lapAId = created.ids[0];
    const lapBId = created.ids[1];
    const findingExpectationA = created.findingExpectations[0];
    const findingExpectationB = created.findingExpectations[1];
    const lapIdentity = qualityCacheIdentityForLap(currentEvidence(generations[0]));
    const comparisonIdentity = qualityCacheIdentityForComparison([currentEvidence(generations[0]), currentEvidence(generations[1])]);
    if (
      lapAId === undefined ||
      lapBId === undefined ||
      findingExpectationA === undefined ||
      findingExpectationB === undefined ||
      !lapIdentity ||
      !comparisonIdentity
    ) {
      throw new Error("Expected current quality and finding identities");
    }
    const findingExpectations: readonly [FindingGenerationExpectation, FindingGenerationExpectation] = [findingExpectationA, findingExpectationB];
    const reverseFindingExpectations: readonly [FindingGenerationExpectation, FindingGenerationExpectation] = [findingExpectationB, findingExpectationA];

    expect(await saveAnalysis(lapAId, "fenced single", usage, lapIdentity, findingExpectationA)).toBe(true);
    expect(await saveCompareAnalysis(lapAId, lapBId, "fenced comparison", usage, comparisonIdentity, findingExpectations, "inputs")).toBe(true);
    expect(await getAnalysis(lapAId, findingExpectationA)).not.toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).not.toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, reverseFindingExpectations, "inputs")).toBeNull();

    const changedGenerationExpectation: FindingGenerationExpectation = {
      ...findingExpectationA,
      generationId: `${findingExpectationA.generationId}:next`,
    };
    const changedContentHashExpectation: FindingGenerationExpectation = {
      ...findingExpectationA,
      contentHash: qualityGeneration("finding-content:fence-a-next"),
    };
    const changedCompareExpectations: readonly [FindingGenerationExpectation, FindingGenerationExpectation] = [
      changedContentHashExpectation,
      findingExpectationB,
    ];
    expect(await getAnalysis(lapAId, changedGenerationExpectation)).toBeNull();
    expect(await getAnalysis(lapAId, changedContentHashExpectation)).toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, changedCompareExpectations, "inputs")).toBeNull();

    await db.update(lapAnalyses).set({ findingGenerationKey: null }).where(eq(lapAnalyses.lapId, lapAId)).run();
    await db
      .update(compareAnalyses)
      .set({ findingGenerationKey: null })
      .where(and(eq(compareAnalyses.lapAId, Math.min(lapAId, lapBId)), eq(compareAnalyses.lapBId, Math.max(lapAId, lapBId)), eq(compareAnalyses.kind, "inputs")))
      .run();
    expect(await getAnalysis(lapAId, findingExpectationA)).toBeNull();
    expect(await getCompareAnalysis(lapAId, lapBId, findingExpectations, "inputs")).toBeNull();
  });
});
