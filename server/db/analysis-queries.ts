import { createHash } from "node:crypto";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { canonicalJson } from "../../shared/racing/findings/identity";
import { ELIGIBILITY_POLICY_VERSION, type LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { FindingGenerationExpectation } from "../findings/store";
import { combineQualityGenerations } from "../lap-analysis/quality-generation";
import { db } from "./index";
import { findingGenerations, lapAnalyses, compareAnalyses, laps } from "./schema";

export type { FindingGenerationExpectation };

interface AnalysisRow {
  analysis: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
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

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface CacheIdentity {
  qualityGeneration: string | null;
  qualityPolicyVersion: string | null;
}

export type FindingGenerationExpectationPair = readonly [
  FindingGenerationExpectation,
  FindingGenerationExpectation,
];

type FindingGenerationCacheKey = string & {
  readonly __findingGenerationCacheKey: unique symbol;
};

interface PersistedLapIdentity {
  quality: LapQualitySummary | null;
  qualityGeneration: string | null;
  qualityPolicyVersion: string | null;
}

export interface AnalysisQualityIdentity extends CacheIdentity {
  hasQuality: boolean;
}

const FINALIZED_QUALITY_GENERATION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function analysisQualityIdentityForLap(lap: { quality?: LapQualitySummary | null; qualityGeneration?: string | null }): AnalysisQualityIdentity {
  return {
    hasQuality: lap.quality != null,
    qualityGeneration: lap.qualityGeneration ?? null,
    qualityPolicyVersion: lap.quality?.provenance.policyVersion ?? null,
  };
}

function currentPersistedLapIdentity(row: PersistedLapIdentity | undefined): CacheIdentity | undefined {
  if (!row) return undefined;
  if (!row.quality) return undefined;
  if (
    row.qualityPolicyVersion !== ELIGIBILITY_POLICY_VERSION ||
    row.quality.provenance.policyVersion !== ELIGIBILITY_POLICY_VERSION ||
    row.quality.provenance.outputGeneration !== row.qualityGeneration ||
    !row.qualityGeneration ||
    !FINALIZED_QUALITY_GENERATION_PATTERN.test(row.qualityGeneration)
  ) {
    return undefined;
  }
  return {
    qualityGeneration: row.qualityGeneration,
    qualityPolicyVersion: row.qualityPolicyVersion,
  };
}

function currentExpectedLapIdentity(identity: AnalysisQualityIdentity): CacheIdentity | undefined {
  if (!identity.hasQuality) return undefined;
  if (identity.qualityPolicyVersion !== ELIGIBILITY_POLICY_VERSION || !identity.qualityGeneration || !FINALIZED_QUALITY_GENERATION_PATTERN.test(identity.qualityGeneration)) {
    return undefined;
  }
  return {
    qualityGeneration: identity.qualityGeneration,
    qualityPolicyVersion: identity.qualityPolicyVersion,
  };
}

function sameIdentity(left: CacheIdentity, right: CacheIdentity): boolean {
  return left.qualityGeneration === right.qualityGeneration && left.qualityPolicyVersion === right.qualityPolicyVersion;
}

function compareIdentity(left: CacheIdentity | undefined, right: CacheIdentity | undefined): CacheIdentity | undefined {
  if (!left || !right) return undefined;
  if (left.qualityGeneration == null || right.qualityGeneration == null) {
    return left.qualityGeneration == null && right.qualityGeneration == null && left.qualityPolicyVersion == null && right.qualityPolicyVersion == null
      ? { qualityGeneration: null, qualityPolicyVersion: null }
      : undefined;
  }
  return {
    qualityGeneration: combineQualityGenerations([left.qualityGeneration, right.qualityGeneration]),
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
  };
}

async function readLapIdentities(tx: DbTransaction, lapIds: readonly number[]): Promise<Map<number, CacheIdentity | undefined>> {
  const rows = await tx
    .select({
      id: laps.id,
      quality: laps.quality,
      qualityGeneration: laps.qualityGeneration,
      qualityPolicyVersion: laps.qualityPolicyVersion,
    })
    .from(laps)
    .where(inArray(laps.id, [...lapIds]))
    .all();
  const result = new Map<number, CacheIdentity | undefined>();
  for (const row of rows) {
    result.set(row.id, currentPersistedLapIdentity(row));
  }
  return result;
}

function findingGenerationCacheKey(value: unknown): FindingGenerationCacheKey {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}` as FindingGenerationCacheKey;
}

function expectationLapId(expectation: FindingGenerationExpectation): number | null {
  const value = expectation.scope.lapId;
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function expectationMatchesLap(
  expectation: FindingGenerationExpectation,
  lapId: number,
): boolean {
  return expectation.scope.kind === "lap" && expectationLapId(expectation) === lapId;
}

function expectationCacheKey(
  expectation: FindingGenerationExpectation,
): FindingGenerationCacheKey {
  return findingGenerationCacheKey({
    generationId: expectation.generationId,
    contentHash: expectation.contentHash,
  });
}

function compareExpectationCacheKey(
  expectations: FindingGenerationExpectationPair,
): FindingGenerationCacheKey {
  return findingGenerationCacheKey(
    [...expectations]
      .sort((left, right) => (expectationLapId(left) ?? 0) - (expectationLapId(right) ?? 0))
      .map(({ generationId, contentHash }) => ({ generationId, contentHash })),
  );
}

async function hasCurrentFindingGeneration(
  tx: DbTransaction,
  expectation: FindingGenerationExpectation,
): Promise<boolean> {
  const row = await tx
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
  return row != null;
}

async function hasCurrentFindingGenerationPair(
  tx: DbTransaction,
  expectations: FindingGenerationExpectationPair,
): Promise<boolean> {
  return (
    (await hasCurrentFindingGeneration(tx, expectations[0])) &&
    (await hasCurrentFindingGeneration(tx, expectations[1]))
  );
}

/**
 * Save or replace AI analysis for a lap.
 */

export async function getAnalysis(
  lapId: number,
  expectedFindingGeneration?: FindingGenerationExpectation,
): Promise<AnalysisRow | null> {
  if (
    expectedFindingGeneration &&
    !expectationMatchesLap(expectedFindingGeneration, lapId)
  ) {
    return null;
  }
  return db.transaction(async (tx) => {
    if (
      expectedFindingGeneration &&
      !(await hasCurrentFindingGeneration(tx, expectedFindingGeneration))
    ) {
      return null;
    }
    const identities = await readLapIdentities(tx, [lapId]);
    const identity = identities.get(lapId);
    if (!identity) return null;
    const row = await tx
      .select({
        analysis: lapAnalyses.analysis,
        inputTokens: lapAnalyses.inputTokens,
        outputTokens: lapAnalyses.outputTokens,
        costUsd: lapAnalyses.costUsd,
        durationMs: lapAnalyses.durationMs,
        model: lapAnalyses.model,
        qualityGeneration: lapAnalyses.qualityGeneration,
        qualityPolicyVersion: lapAnalyses.qualityPolicyVersion,
      })
      .from(lapAnalyses)
      .where(
        and(
          eq(lapAnalyses.lapId, lapId),
          expectedFindingGeneration
            ? eq(
                lapAnalyses.findingGenerationKey,
                expectationCacheKey(expectedFindingGeneration),
              )
            : isNull(lapAnalyses.findingGenerationKey),
        ),
      )
      .get();
    return row && sameIdentity(row, identity) ? row : null;
  });
}

export async function saveAnalysis(
  lapId: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentity: AnalysisQualityIdentity,
  expectedFindingGeneration?: FindingGenerationExpectation,
): Promise<void> {
  if (
    expectedFindingGeneration &&
    !expectationMatchesLap(expectedFindingGeneration, lapId)
  ) {
    return;
  }
  await db.transaction(async (tx) => {
    if (
      expectedFindingGeneration &&
      !(await hasCurrentFindingGeneration(tx, expectedFindingGeneration))
    ) {
      return;
    }
    const identities = await readLapIdentities(tx, [lapId]);
    const identity = identities.get(lapId);
    const expected = currentExpectedLapIdentity(expectedIdentity);
    if (!identity || !expected || !sameIdentity(identity, expected)) return;
    const existing = await tx
      .select({ id: lapAnalyses.id })
      .from(lapAnalyses)
      .where(eq(lapAnalyses.lapId, lapId))
      .get();
    const values = {
      analysis,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      durationMs: usage.durationMs,
      model: usage.model,
      createdAt: sql`(datetime('now'))`,
      findingGenerationKey: expectedFindingGeneration
        ? expectationCacheKey(expectedFindingGeneration)
        : null,
      ...identity,
    };
    if (existing) {
      await tx
        .update(lapAnalyses)
        .set(values)
        .where(eq(lapAnalyses.lapId, lapId))
        .run();
    } else {
      await tx.insert(lapAnalyses).values({ lapId, ...values }).run();
    }
  });
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
  kind: string = "inputs",
  expectedFindingGenerations?: FindingGenerationExpectationPair,
): Promise<AnalysisRow | null> {
  if (
    expectedFindingGenerations &&
    (!expectationMatchesLap(expectedFindingGenerations[0], idA) ||
      !expectationMatchesLap(expectedFindingGenerations[1], idB))
  ) {
    return null;
  }
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return db.transaction(async (tx) => {
    if (
      expectedFindingGenerations &&
      !(await hasCurrentFindingGenerationPair(tx, expectedFindingGenerations))
    ) {
      return null;
    }
    const identities = await readLapIdentities(tx, [lo, hi]);
    const identity = compareIdentity(identities.get(lo), identities.get(hi));
    if (!identity) return null;
    const row = await tx
      .select({
        analysis: compareAnalyses.analysis,
        inputTokens: compareAnalyses.inputTokens,
        outputTokens: compareAnalyses.outputTokens,
        costUsd: compareAnalyses.costUsd,
        durationMs: compareAnalyses.durationMs,
        model: compareAnalyses.model,
        qualityGeneration: compareAnalyses.qualityGeneration,
        qualityPolicyVersion: compareAnalyses.qualityPolicyVersion,
      })
      .from(compareAnalyses)
      .where(
        and(
          eq(compareAnalyses.lapAId, lo),
          eq(compareAnalyses.lapBId, hi),
          eq(compareAnalyses.kind, kind),
          expectedFindingGenerations
            ? eq(
                compareAnalyses.findingGenerationKey,
                compareExpectationCacheKey(expectedFindingGenerations),
              )
            : isNull(compareAnalyses.findingGenerationKey),
        ),
      )
      .get();
    return row && sameIdentity(row, identity) ? row : null;
  });
}

export async function saveCompareAnalysis(
  idA: number,
  idB: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentities: readonly [
    AnalysisQualityIdentity,
    AnalysisQualityIdentity,
  ],
  kind: string = "inputs",
  expectedFindingGenerations?: FindingGenerationExpectationPair,
): Promise<void> {
  if (
    expectedFindingGenerations &&
    (!expectationMatchesLap(expectedFindingGenerations[0], idA) ||
      !expectationMatchesLap(expectedFindingGenerations[1], idB))
  ) {
    return;
  }
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db.transaction(async (tx) => {
    if (
      expectedFindingGenerations &&
      !(await hasCurrentFindingGenerationPair(tx, expectedFindingGenerations))
    ) {
      return;
    }
    const identities = await readLapIdentities(tx, [lo, hi]);
    const identity = compareIdentity(identities.get(lo), identities.get(hi));
    const expected = compareIdentity(
      currentExpectedLapIdentity(expectedIdentities[0]),
      currentExpectedLapIdentity(expectedIdentities[1]),
    );
    if (!identity || !expected || !sameIdentity(identity, expected)) return;
    const existing = await tx
      .select({ id: compareAnalyses.id })
      .from(compareAnalyses)
      .where(
        and(
          eq(compareAnalyses.lapAId, lo),
          eq(compareAnalyses.lapBId, hi),
          eq(compareAnalyses.kind, kind),
        ),
      )
      .get();
    const values = {
      analysis,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      durationMs: usage.durationMs,
      model: usage.model,
      createdAt: sql`(datetime('now'))`,
      findingGenerationKey: expectedFindingGenerations
        ? compareExpectationCacheKey(expectedFindingGenerations)
        : null,
      ...identity,
    };
    if (existing) {
      await tx
        .update(compareAnalyses)
        .set(values)
        .where(eq(compareAnalyses.id, existing.id))
        .run();
    } else {
      await tx
        .insert(compareAnalyses)
        .values({ lapAId: lo, lapBId: hi, kind, ...values })
        .run();
    }
  });
}

export async function deleteCompareAnalysis(idA: number, idB: number, kind: string = "inputs"): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db
    .delete(compareAnalyses)
    .where(and(eq(compareAnalyses.lapAId, lo), eq(compareAnalyses.lapBId, hi), eq(compareAnalyses.kind, kind)))
    .run();
}
