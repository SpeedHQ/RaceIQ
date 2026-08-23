import { createHash } from "node:crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION, type EligibilityDecisionSet, type LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilitySnapshotCurrent } from "../../shared/racing/quality/policies";
import { combineQualityGenerations } from "../lap-analysis/quality-generation";
import { db } from "./index";
import { findingGenerations, lapAnalyses, compareAnalyses, laps } from "./schema";
import type { FindingGenerationExpectation } from "../findings/store";
import { canonicalJson } from "../../shared/racing/findings/identity";
export type { FindingGenerationExpectation };

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

type AnalysisDatabase = Pick<typeof db, "select" | "insert" | "update" | "delete">;

function expectationCacheKey(expectation: FindingGenerationExpectation): FindingGenerationCacheKey {
  return findingGenerationCacheKey({
    generationId: expectation.generationId,
    contentHash: expectation.contentHash,
  });
}

async function hasCurrentFindingGeneration(
  database: AnalysisDatabase,
  expectation: FindingGenerationExpectation,
): Promise<boolean> {
  const row = await database
    .select({ id: findingGenerations.id })
    .from(findingGenerations)
    .where(
      and(
        eq(findingGenerations.id, expectation.generationId),
        eq(findingGenerations.scopeKey, canonicalJson(expectation.scope)),
        eq(findingGenerations.contentHash, expectation.contentHash),
        eq(findingGenerations.status, "current"),
      ),
    )
    .get();
  return !!row;
}

async function currentLapQualityIdentity(
  database: AnalysisDatabase,
  lapId: number,
): Promise<QualityCacheIdentity | null> {
  const row = await database
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

async function currentCompareQualityIdentity(
  database: AnalysisDatabase,
  idA: number,
  idB: number,
): Promise<QualityCacheIdentity | null> {
  const rows = await database
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

export async function getAnalysis(
  lapId: number,
  expectedFindingGeneration: FindingGenerationExpectation,
): Promise<AnalysisRow | null> {
  if (!expectationMatchesLap(expectedFindingGeneration, lapId)) return null;
  return db.transaction(async (tx) => {
    if (!(await hasCurrentFindingGeneration(tx, expectedFindingGeneration))) return null;
    const identity = await currentLapQualityIdentity(tx, lapId);
    if (!identity || identity.policyVersion !== ELIGIBILITY_POLICY_VERSION) return null;
    const row = await tx
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
          eq(lapAnalyses.findingGenerationKey, expectationCacheKey(expectedFindingGeneration)),
        ),
      )
      .get();
    return row ?? null;
  });
}

export async function saveAnalysis(
  lapId: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentity: QualityCacheIdentity,
  expectedFindingGeneration: FindingGenerationExpectation,
): Promise<boolean> {
  if (!expectationMatchesLap(expectedFindingGeneration, lapId)) return false;
  return db.transaction(async (tx) => {
    if (!(await hasCurrentFindingGeneration(tx, expectedFindingGeneration))) return false;
    const currentIdentity = await currentLapQualityIdentity(tx, lapId);
    if (!currentIdentity || expectedIdentity.generation !== currentIdentity.generation || expectedIdentity.policyVersion !== currentIdentity.policyVersion) {
      return false;
    }
    const existing = await tx.select({ id: lapAnalyses.id }).from(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).get();
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
      findingGenerationKey: expectationCacheKey(expectedFindingGeneration),
    };
    if (existing) {
      await tx.update(lapAnalyses).set(values).where(eq(lapAnalyses.lapId, lapId)).run();
    } else {
      await tx.insert(lapAnalyses).values({ lapId, ...values }).run();
    }
    return true;
  });
}

export async function deleteAnalysis(lapId: number): Promise<void> {
  await db.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).run();
}
export type FindingGenerationExpectationPair = readonly [
  FindingGenerationExpectation,
  FindingGenerationExpectation,
];

function expectationLapId(expectation: FindingGenerationExpectation): number | null {
  const value = expectation.scope.lapId;
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function compareExpectationCacheKey(
  pair: FindingGenerationExpectationPair,
): FindingGenerationCacheKey {
  return findingGenerationCacheKey(
    [...pair]
      .sort((left, right) => (expectationLapId(left) ?? 0) - (expectationLapId(right) ?? 0))
      .map(({ generationId, contentHash }) => ({ generationId, contentHash })),
  );
}

function expectationMatchesLap(expectation: FindingGenerationExpectation, lapId: number): boolean {
  return expectation.scope.kind === "lap" && expectationLapId(expectation) === lapId;
}

export async function getCompareAnalysis(
  idA: number,
  idB: number,
  expectedFindingGenerations: FindingGenerationExpectationPair,
  kind: string = "inputs",
): Promise<AnalysisRow | null> {
  if (
    !expectationMatchesLap(expectedFindingGenerations[0], idA) ||
    !expectationMatchesLap(expectedFindingGenerations[1], idB)
  ) return null;
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return db.transaction(async (tx) => {
    if (!(await hasCurrentFindingGeneration(tx, expectedFindingGenerations[0])) ||
        !(await hasCurrentFindingGeneration(tx, expectedFindingGenerations[1]))) return null;
    const identity = await currentCompareQualityIdentity(tx, lo, hi);
    if (!identity) return null;
    const row = await tx
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
          eq(compareAnalyses.requestLapAId, idA),
          eq(compareAnalyses.requestLapBId, idB),
          eq(compareAnalyses.kind, kind),
          eq(compareAnalyses.qualityGeneration, identity.generation),
          eq(compareAnalyses.qualityPolicyVersion, identity.policyVersion),
          eq(compareAnalyses.findingGenerationKey, compareExpectationCacheKey(expectedFindingGenerations)),
        ),
      )
      .get();
    return row ?? null;
  });
}

export async function saveCompareAnalysis(
  idA: number,
  idB: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentity: QualityCacheIdentity,
  expectedFindingGenerations: FindingGenerationExpectationPair,
  kind: string = "inputs",
): Promise<boolean> {
  if (
    !expectationMatchesLap(expectedFindingGenerations[0], idA) ||
    !expectationMatchesLap(expectedFindingGenerations[1], idB)
  ) return false;
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return db.transaction(async (tx) => {
    if (!(await hasCurrentFindingGeneration(tx, expectedFindingGenerations[0])) ||
        !(await hasCurrentFindingGeneration(tx, expectedFindingGenerations[1]))) return false;
    const currentIdentity = await currentCompareQualityIdentity(tx, lo, hi);
    if (!currentIdentity || expectedIdentity.generation !== currentIdentity.generation || expectedIdentity.policyVersion !== currentIdentity.policyVersion) {
      return false;
    }
    const existing = await tx
      .select({ id: compareAnalyses.id })
      .from(compareAnalyses)
      .where(and(
        eq(compareAnalyses.requestLapAId, idA),
        eq(compareAnalyses.requestLapBId, idB),
        eq(compareAnalyses.kind, kind),
      ))
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
      findingGenerationKey: compareExpectationCacheKey(expectedFindingGenerations),
      qualityPolicyVersion: expectedIdentity.policyVersion,
    };
    if (existing) {
      await tx
        .update(compareAnalyses)
        .set(values)
        .where(eq(compareAnalyses.id, existing.id))
        .run();
    } else {
      await tx.insert(compareAnalyses).values({
        lapAId: lo,
        lapBId: hi,
        requestLapAId: idA,
        requestLapBId: idB,
        kind,
        ...values,
      }).run();
    }
    return true;
  });
}

export async function deleteCompareAnalysis(idA: number, idB: number, kind: string = "inputs"): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db
    .delete(compareAnalyses)
    .where(and(
      eq(compareAnalyses.lapAId, lo),
      eq(compareAnalyses.lapBId, hi),
      eq(compareAnalyses.requestLapAId, idA),
      eq(compareAnalyses.requestLapBId, idB),
      eq(compareAnalyses.kind, kind),
    ))
    .run();
}
