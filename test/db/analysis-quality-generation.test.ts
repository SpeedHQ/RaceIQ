import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";

import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../shared/racing/quality/contracts";
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

async function createLaps(generations: readonly string[]): Promise<number[]> {
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
    createdLapIds.push(lapId);
  }
  return ids;
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
    const [lapId] = await createLaps([originalGeneration]);
    const expectedIdentity = qualityCacheIdentityForLap(currentEvidence(originalGeneration));
    if (!expectedIdentity) throw new Error("Expected single-lap quality identity");
    expect(await saveAnalysis(lapId!, "existing analysis", usage, expectedIdentity)).toBe(true);

    const staleOutput = await finishModelWork(async () => {
      await db.update(laps).set({ qualityGeneration: currentGeneration }).where(eq(laps.id, lapId!)).run();
    }, "stale model output");
    const saved = await saveAnalysis(lapId!, staleOutput, usage, expectedIdentity);

    expect(saved).toBe(false);
    expect(await getAnalysis(lapId!)).toBeNull();
    const stored = await db
      .select({ analysis: lapAnalyses.analysis, qualityGeneration: lapAnalyses.qualityGeneration })
      .from(lapAnalyses)
      .where(eq(lapAnalyses.lapId, lapId!))
      .get();
    expect(stored).toEqual({
      analysis: "existing analysis",
      qualityGeneration: originalGeneration,
    });
  });

  test("comparison output generated from stale quality is neither cached nor stamped current", async () => {
    const originalGenerations = [qualityGeneration("compare-a"), qualityGeneration("compare-b")] as const;
    const [lapAId, lapBId] = await createLaps(originalGenerations);
    const expectedIdentity = qualityCacheIdentityForComparison([currentEvidence(originalGenerations[0]), currentEvidence(originalGenerations[1])]);
    if (!expectedIdentity) throw new Error("Expected comparison quality identity");
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "existing comparison", usage, expectedIdentity, "inputs")).toBe(true);

    const staleOutput = await finishModelWork(async () => {
      await db.update(laps).set({ qualityGeneration: qualityGeneration("compare-a-current") }).where(eq(laps.id, lapAId!)).run();
    }, "stale comparison output");
    const saved = await saveCompareAnalysis(lapAId!, lapBId!, staleOutput, usage, expectedIdentity, "inputs");

    expect(saved).toBe(false);
    expect(await getCompareAnalysis(lapAId!, lapBId!, "inputs")).toBeNull();
    const [lo, hi] = [lapAId!, lapBId!].sort((left, right) => left - right);
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
    const [lapAId, lapBId] = await createLaps(generations);
    const lapIdentity = qualityCacheIdentityForLap(currentEvidence(generations[0]));
    const comparisonIdentity = qualityCacheIdentityForComparison([currentEvidence(generations[0]), currentEvidence(generations[1])]);
    if (!lapIdentity || !comparisonIdentity) throw new Error("Expected current quality identities");
    expect(await saveAnalysis(lapAId!, "stale single analysis", usage, lapIdentity)).toBe(true);
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "stale comparison", usage, comparisonIdentity, "inputs")).toBe(true);

    await db.update(laps).set({ qualityConfigVersion: "stale-config" }).where(eq(laps.id, lapAId!)).run();

    expect(await getAnalysis(lapAId!)).toBeNull();
    expect(await getCompareAnalysis(lapAId!, lapBId!, "inputs")).toBeNull();
  });

  test("cache reads and writes reject missing, stale-decision, and provisional evidence with matching metadata", async () => {
    const generations = [qualityGeneration("decision-cache-a"), qualityGeneration("decision-cache-b")] as const;
    const [lapAId, lapBId] = await createLaps(generations);
    const lapIdentity = qualityCacheIdentityForLap(currentEvidence(generations[0]));
    const comparisonIdentity = qualityCacheIdentityForComparison([currentEvidence(generations[0]), currentEvidence(generations[1])]);
    if (!lapIdentity || !comparisonIdentity) throw new Error("Expected current quality identities");
    expect(await saveAnalysis(lapAId!, "current single", usage, lapIdentity)).toBe(true);
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "current comparison", usage, comparisonIdentity, "inputs")).toBe(true);

    expect(qualityCacheIdentityForLap({ ...currentEvidence(generations[0]), eligibility: null })).toBeNull();
    expect(qualityCacheIdentityForComparison([{ ...currentEvidence(generations[0]), eligibility: null }, currentEvidence(generations[1])])).toBeNull();
    await db.update(laps).set({ eligibility: null }).where(eq(laps.id, lapAId!)).run();
    expect(await getAnalysis(lapAId!)).toBeNull();
    expect(await getCompareAnalysis(lapAId!, lapBId!, "inputs")).toBeNull();
    expect(await saveAnalysis(lapAId!, "missing decision", usage, lapIdentity)).toBe(false);
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "missing decision", usage, comparisonIdentity, "inputs")).toBe(false);

    const staleEligibility = evaluateAllEligibility(currentQuality(generations[0]));
    staleEligibility["normal-pace"] = { ...staleEligibility["normal-pace"], policyVersion: "legacy-policy" };
    expect(qualityCacheIdentityForLap({ ...currentEvidence(generations[0]), eligibility: staleEligibility })).toBeNull();
    expect(qualityCacheIdentityForComparison([{ ...currentEvidence(generations[0]), eligibility: staleEligibility }, currentEvidence(generations[1])])).toBeNull();
    await db.update(laps).set({ eligibility: staleEligibility as EligibilityDecisionSet }).where(eq(laps.id, lapAId!)).run();
    expect(await getAnalysis(lapAId!)).toBeNull();
    expect(await getCompareAnalysis(lapAId!, lapBId!, "inputs")).toBeNull();
    expect(await saveAnalysis(lapAId!, "stale decision", usage, lapIdentity)).toBe(false);
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "stale decision", usage, comparisonIdentity, "inputs")).toBe(false);

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
    await db.update(laps).set(provisionalEvidence).where(eq(laps.id, lapAId!)).run();
    const provisionalComparisonGeneration = combineQualityGenerations(["provisional", generations[1]]);
    await db.update(lapAnalyses).set({ qualityGeneration: "provisional" }).where(eq(lapAnalyses.lapId, lapAId!)).run();
    await db
      .update(compareAnalyses)
      .set({ qualityGeneration: provisionalComparisonGeneration })
      .where(and(eq(compareAnalyses.lapAId, Math.min(lapAId!, lapBId!)), eq(compareAnalyses.lapBId, Math.max(lapAId!, lapBId!)), eq(compareAnalyses.kind, "inputs")))
      .run();

    const provisionalIdentity = { generation: "provisional", policyVersion: ELIGIBILITY_POLICY_VERSION };
    const provisionalComparisonIdentity = { generation: provisionalComparisonGeneration, policyVersion: ELIGIBILITY_POLICY_VERSION };
    expect(await getAnalysis(lapAId!)).toBeNull();
    expect(await getCompareAnalysis(lapAId!, lapBId!, "inputs")).toBeNull();
    expect(await saveAnalysis(lapAId!, "provisional", usage, provisionalIdentity)).toBe(false);
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "provisional", usage, provisionalComparisonIdentity, "inputs")).toBe(false);
  });
});
