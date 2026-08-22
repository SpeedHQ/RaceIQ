import { createHash } from "node:crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent } from "../../shared/racing/quality/policies";
import { combineQualityGenerations } from "../lap-analysis/quality-generation";
import { db } from "./index";
import { lapAnalyses, compareAnalyses, laps } from "./schema";

interface AnalysisRow {
  analysis: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}
export interface QualityCacheIdentity {
  generation: string;
  policyVersion: string;
}
export interface LapQualityCacheEvidence {
  qualityGeneration?: string | null;
  qualityStale?: boolean;
  qualitySchemaVersion?: string | null;
  qualityPolicyVersion?: string | null;
  qualityConfigVersion?: string | null;
  quality?: LapQualitySummary | null;
  eligibility?: Partial<EligibilityDecisionSet> | null;
}

export type FindingGenerationCacheKey = string & { readonly __findingGenerationCacheKey: unique symbol };

export interface FindingGenerationCacheReceipt {
  generationId: string;
  contentHash: string;
}

export interface ComparisonFindingGenerationCacheInput {
  lapId: number;
  receipt: FindingGenerationCacheReceipt;
}

function findingGenerationCacheKey(value: unknown): FindingGenerationCacheKey {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}` as FindingGenerationCacheKey;
}

/**
 * Fences a lap cache entry to one stored finding-generation receipt.
 */
export function lapFindingGenerationCacheKey(receipt: FindingGenerationCacheReceipt): FindingGenerationCacheKey {
  return findingGenerationCacheKey({
    generationId: receipt.generationId,
    contentHash: receipt.contentHash,
  });
}

/**
 * Fences a comparison cache entry to its two stored finding-generation receipts.
 * Lap ids make A/B ordering canonical even when callers receive them reversed.
 */
export function compareFindingGenerationCacheKey(
  inputs: readonly [ComparisonFindingGenerationCacheInput, ComparisonFindingGenerationCacheInput],
): FindingGenerationCacheKey {
  return findingGenerationCacheKey(
    [...inputs]
      .sort((left, right) => left.lapId - right.lapId)
      .map(({ receipt }) => ({
        generationId: receipt.generationId,
        contentHash: receipt.contentHash,
      })),
  );
}

export function qualityCacheIdentityForLap(evidence: LapQualityCacheEvidence): QualityCacheIdentity | null {
  if (!isEligibilitySnapshotCurrent(evidence)) return null;
  return {
    generation: evidence.qualityGeneration!,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
  };
}

export function qualityCacheIdentityForComparison(evidence: readonly [LapQualityCacheEvidence, LapQualityCacheEvidence]): QualityCacheIdentity | null {
  return combineCompareIdentityRows(
    evidence.map((lap) => (isEligibilitySnapshotCurrent(lap) ? { generation: lap.qualityGeneration ?? null, policyVersion: ELIGIBILITY_POLICY_VERSION } : { generation: null, policyVersion: null })),
  );
}

interface PersistedQualityIdentityRow {
  generation: string | null;
  policyVersion: string | null;
  schemaVersion: string | null;
  configurationVersion: string | null;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
}

function currentQualityCacheIdentity(row: PersistedQualityIdentityRow | null | undefined): QualityCacheIdentity | null {
  if (
    !row?.quality ||
    !row.generation ||
    !isEligibilitySnapshotCurrent({
      quality: row.quality,
      eligibility: row.eligibility,
      qualityGeneration: row.generation,
      qualitySchemaVersion: row.schemaVersion,
      qualityPolicyVersion: row.policyVersion,
      qualityConfigVersion: row.configurationVersion,
    })
  ) {
    return null;
  }
  return { generation: row.generation, policyVersion: ELIGIBILITY_POLICY_VERSION };
}

function combineCompareIdentityRows(rows: Array<{ generation: string | null; policyVersion: string | null }>): QualityCacheIdentity | null {
  if (rows.length !== 2) return null;
  if (rows.some(({ policyVersion }) => policyVersion !== ELIGIBILITY_POLICY_VERSION)) return null;
  if (rows.some(({ generation }) => !generation)) return null;
  return {
    generation: combineQualityGenerations(rows.map(({ generation }) => generation!)),
    policyVersion: ELIGIBILITY_POLICY_VERSION,
  };
}

export async function getLapQualityIdentity(lapId: number): Promise<QualityCacheIdentity | null> {
  const row = await db
    .select({
      generation: laps.qualityGeneration,
      policyVersion: laps.qualityPolicyVersion,
      schemaVersion: laps.qualitySchemaVersion,
      configurationVersion: laps.qualityConfigVersion,
      quality: laps.quality,
      eligibility: laps.eligibility,
    })
    .from(laps)
    .where(eq(laps.id, lapId))
    .get();
  return currentQualityCacheIdentity(row);
}

export async function getCompareQualityIdentity(idA: number, idB: number): Promise<QualityCacheIdentity | null> {
  const rows = await db
    .select({
      id: laps.id,
      generation: laps.qualityGeneration,
      policyVersion: laps.qualityPolicyVersion,
      schemaVersion: laps.qualitySchemaVersion,
      configurationVersion: laps.qualityConfigVersion,
      quality: laps.quality,
      eligibility: laps.eligibility,
    })
    .from(laps)
    .where(inArray(laps.id, [idA, idB]))
    .all();
  return combineCompareIdentityRows(rows.map((row) => currentQualityCacheIdentity(row) ?? { generation: null, policyVersion: null }));
}

/**
 * Get cached AI analysis for a lap. Returns analysis + usage stats or null.
 */

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

/**
 * Save or replace AI analysis for a lap.
 */

export async function getAnalysis(lapId: number, expectedFindingGenerationKey: FindingGenerationCacheKey): Promise<AnalysisRow | null> {
  const identity = await getLapQualityIdentity(lapId);
  if (!identity || identity.policyVersion !== ELIGIBILITY_POLICY_VERSION) return null;
  const row = await db
    .select({
      analysis: lapAnalyses.analysis,
      inputTokens: lapAnalyses.inputTokens,
      outputTokens: lapAnalyses.outputTokens,
      costUsd: lapAnalyses.costUsd,
      durationMs: lapAnalyses.durationMs,
      model: lapAnalyses.model,
    })
    .from(lapAnalyses)
    .where(
      and(
        eq(lapAnalyses.lapId, lapId),
        eq(lapAnalyses.qualityGeneration, identity.generation),
        eq(lapAnalyses.qualityPolicyVersion, identity.policyVersion),
        eq(lapAnalyses.findingGenerationKey, expectedFindingGenerationKey),
      ),
    )
    .get();
  return row ?? null;
}

export async function saveAnalysis(
  lapId: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentity: QualityCacheIdentity,
  expectedFindingGenerationKey: FindingGenerationCacheKey,
): Promise<boolean> {
  const currentIdentity = await getLapQualityIdentity(lapId);
  if (!currentIdentity || expectedIdentity.generation !== currentIdentity.generation || expectedIdentity.policyVersion !== currentIdentity.policyVersion) {
    return false;
  }
  const existing = await db.select({ id: lapAnalyses.id }).from(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).get();
  const values = {
    analysis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
    qualityGeneration: expectedIdentity.generation,
    qualityPolicyVersion: expectedIdentity.policyVersion,
    findingGenerationKey: expectedFindingGenerationKey,
  };

  if (existing) {
    await db.update(lapAnalyses).set(values).where(eq(lapAnalyses.lapId, lapId)).run();
  } else {
    await db
      .insert(lapAnalyses)
      .values({ lapId, ...values })
      .run();
  }
  return true;
}

/**
 * Delete cached AI analysis for a lap.
 */

export async function deleteAnalysis(lapId: number): Promise<void> {
  await db.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).run();
}

/**
 * Look up a cached compare-analysis for a lap pair.
 * The pair key is canonical (min, max) so the order of arguments doesn't matter.
 */

export async function getCompareAnalysis(
  idA: number,
  idB: number,
  expectedFindingGenerationKey: FindingGenerationCacheKey,
  kind: string = "inputs",
): Promise<AnalysisRow | null> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  const identity = await getCompareQualityIdentity(lo, hi);
  if (!identity) return null;
  const row = await db
    .select({
      analysis: compareAnalyses.analysis,
      inputTokens: compareAnalyses.inputTokens,
      outputTokens: compareAnalyses.outputTokens,
      costUsd: compareAnalyses.costUsd,
      durationMs: compareAnalyses.durationMs,
      model: compareAnalyses.model,
    })
    .from(compareAnalyses)
    .where(
      and(
        eq(compareAnalyses.lapAId, lo),
        eq(compareAnalyses.lapBId, hi),
        eq(compareAnalyses.kind, kind),
        eq(compareAnalyses.qualityGeneration, identity.generation),
        eq(compareAnalyses.qualityPolicyVersion, identity.policyVersion),
        eq(compareAnalyses.findingGenerationKey, expectedFindingGenerationKey),
      ),
    )
    .get();
  return row ?? null;
}

export async function saveCompareAnalysis(
  idA: number,
  idB: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentity: QualityCacheIdentity,
  expectedFindingGenerationKey: FindingGenerationCacheKey,
  kind: string = "inputs",
): Promise<boolean> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  const currentIdentity = await getCompareQualityIdentity(lo, hi);
  if (!currentIdentity || expectedIdentity.generation !== currentIdentity.generation || expectedIdentity.policyVersion !== currentIdentity.policyVersion) {
    return false;
  }
  const existing = await db
    .select({ id: compareAnalyses.id })
    .from(compareAnalyses)
    .where(and(eq(compareAnalyses.lapAId, lo), eq(compareAnalyses.lapBId, hi), eq(compareAnalyses.kind, kind)))
    .get();
  const values = {
    analysis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
    qualityGeneration: expectedIdentity.generation,
    findingGenerationKey: expectedFindingGenerationKey,
    qualityPolicyVersion: expectedIdentity.policyVersion,
  };
  if (existing) {
    await db
      .update(compareAnalyses)
      .set(values)
      .where(and(eq(compareAnalyses.lapAId, lo), eq(compareAnalyses.lapBId, hi), eq(compareAnalyses.kind, kind)))
      .run();
  } else {
    await db
      .insert(compareAnalyses)
      .values({ lapAId: lo, lapBId: hi, kind, ...values })
      .run();
  }
  return true;
}

export async function deleteCompareAnalysis(idA: number, idB: number, kind: string = "inputs"): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db
    .delete(compareAnalyses)
    .where(and(eq(compareAnalyses.lapAId, lo), eq(compareAnalyses.lapBId, hi), eq(compareAnalyses.kind, kind)))
    .run();
}
