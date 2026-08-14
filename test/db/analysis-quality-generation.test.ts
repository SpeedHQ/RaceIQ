import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION, type LapQualitySummary } from "../../shared/racing/quality/contracts";
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

const createdSessionIds: number[] = [];
const createdLapIds: number[] = [];

const usage: AnalysisUsage = {
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0,
  durationMs: 30,
  model: "race-test-model",
};

function currentQuality(generation: string): LapQualitySummary {
  return {
    provenance: {
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: "sha256:test-source",
      outputGeneration: generation,
    },
  } as LapQualitySummary;
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
          qualityGeneration: generation,
          qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
          quality: currentQuality(generation),
          qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
          qualityConfigVersion: QUALITY_CONFIG_VERSION,
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
    const originalGeneration = "sha256:single-prompt";
    const currentGeneration = "sha256:single-current";
    const [lapId] = await createLaps([originalGeneration]);
    const expectedIdentity = qualityCacheIdentityForLap({
      qualityGeneration: originalGeneration,
      quality: currentQuality(originalGeneration),
    });
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
    const originalGenerations = ["sha256:compare-a", "sha256:compare-b"] as const;
    const [lapAId, lapBId] = await createLaps(originalGenerations);
    const expectedIdentity = qualityCacheIdentityForComparison([
      {
        qualityGeneration: originalGenerations[0],
        quality: currentQuality(originalGenerations[0]),
      },
      {
        qualityGeneration: originalGenerations[1],
        quality: currentQuality(originalGenerations[1]),
      },
    ]);
    if (!expectedIdentity) throw new Error("Expected comparison quality identity");
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "existing comparison", usage, expectedIdentity, "inputs")).toBe(true);

    const staleOutput = await finishModelWork(async () => {
      await db.update(laps).set({ qualityGeneration: "sha256:compare-a-current" }).where(eq(laps.id, lapAId!)).run();
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
    const generations = ["sha256:stale-cache-a", "sha256:stale-cache-b"] as const;
    const [lapAId, lapBId] = await createLaps(generations);
    const lapIdentity = qualityCacheIdentityForLap({
      qualityGeneration: generations[0],
      quality: currentQuality(generations[0]),
    });
    const comparisonIdentity = qualityCacheIdentityForComparison([
      { qualityGeneration: generations[0], quality: currentQuality(generations[0]) },
      { qualityGeneration: generations[1], quality: currentQuality(generations[1]) },
    ]);
    if (!lapIdentity || !comparisonIdentity) throw new Error("Expected current quality identities");
    expect(await saveAnalysis(lapAId!, "stale single analysis", usage, lapIdentity)).toBe(true);
    expect(await saveCompareAnalysis(lapAId!, lapBId!, "stale comparison", usage, comparisonIdentity, "inputs")).toBe(true);

    await db.update(laps).set({ qualityConfigVersion: "stale-config" }).where(eq(laps.id, lapAId!)).run();

    expect(await getAnalysis(lapAId!)).toBeNull();
    expect(await getCompareAnalysis(lapAId!, lapBId!, "inputs")).toBeNull();
  });
});
