import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "./index";
import { lapAnalyses, compareAnalyses, laps } from "./schema";
import {
  ELIGIBILITY_POLICY_VERSION,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import { combineQualityGenerations } from "../lap-analysis/quality-generation";

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

interface PersistedLapIdentity {
  quality: LapQualitySummary | null;
  qualityGeneration: string | null;
  qualityPolicyVersion: string | null;
}

export interface AnalysisQualityIdentity extends CacheIdentity {
  hasQuality: boolean;
}

const FINALIZED_QUALITY_GENERATION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function analysisQualityIdentityForLap(lap: {
  quality?: LapQualitySummary | null;
  qualityGeneration?: string | null;
}): AnalysisQualityIdentity {
  return {
    hasQuality: lap.quality != null,
    qualityGeneration: lap.qualityGeneration ?? null,
    qualityPolicyVersion: lap.quality?.provenance.policyVersion ?? null,
  };
}

function currentPersistedLapIdentity(
  row: PersistedLapIdentity | undefined,
): CacheIdentity | undefined {
  if (!row) return undefined;
  if (!row.quality) {
    return row.qualityGeneration == null && row.qualityPolicyVersion == null
      ? { qualityGeneration: null, qualityPolicyVersion: null }
      : undefined;
  }
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

function currentExpectedLapIdentity(
  identity: AnalysisQualityIdentity,
): CacheIdentity | undefined {
  if (!identity.hasQuality) {
    return identity.qualityGeneration == null &&
      identity.qualityPolicyVersion == null
      ? { qualityGeneration: null, qualityPolicyVersion: null }
      : undefined;
  }
  if (
    identity.qualityPolicyVersion !== ELIGIBILITY_POLICY_VERSION ||
    !identity.qualityGeneration ||
    !FINALIZED_QUALITY_GENERATION_PATTERN.test(identity.qualityGeneration)
  ) {
    return undefined;
  }
  return {
    qualityGeneration: identity.qualityGeneration,
    qualityPolicyVersion: identity.qualityPolicyVersion,
  };
}

function sameIdentity(
  left: CacheIdentity,
  right: CacheIdentity,
): boolean {
  return (
    left.qualityGeneration === right.qualityGeneration &&
    left.qualityPolicyVersion === right.qualityPolicyVersion
  );
}

function compareIdentity(
  left: CacheIdentity | undefined,
  right: CacheIdentity | undefined,
): CacheIdentity | undefined {
  if (!left || !right) return undefined;
  if (
    left.qualityGeneration == null ||
    right.qualityGeneration == null
  ) {
    return left.qualityGeneration == null &&
      right.qualityGeneration == null &&
      left.qualityPolicyVersion == null &&
      right.qualityPolicyVersion == null
      ? { qualityGeneration: null, qualityPolicyVersion: null }
      : undefined;
  }
  return {
    qualityGeneration: combineQualityGenerations([
      left.qualityGeneration,
      right.qualityGeneration,
    ]),
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
  };
}

async function readLapIdentities(
  tx: DbTransaction,
  lapIds: readonly number[],
): Promise<Map<number, CacheIdentity | undefined>> {
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

/**
 * Save or replace AI analysis for a lap.
 */

export async function getAnalysis(lapId: number): Promise<AnalysisRow | null> {
  return db.transaction(async (tx) => {
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
      .where(eq(lapAnalyses.lapId, lapId))
      .get();
    return row && sameIdentity(row, identity) ? row : null;
  });
}


export async function saveAnalysis(
  lapId: number,
  analysis: string,
  usage: AnalysisUsage,
  expectedIdentity: AnalysisQualityIdentity,
): Promise<void> {
  await db.transaction(async (tx) => {
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
): Promise<AnalysisRow | null> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return db.transaction(async (tx) => {
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
): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db.transaction(async (tx) => {
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
      ...identity,
    };
    if (existing) {
      await tx
        .update(compareAnalyses)
        .set(values)
        .where(
          and(
            eq(compareAnalyses.lapAId, lo),
            eq(compareAnalyses.lapBId, hi),
            eq(compareAnalyses.kind, kind),
          ),
        )
        .run();
    } else {
      await tx
        .insert(compareAnalyses)
        .values({ lapAId: lo, lapBId: hi, kind, ...values })
        .run();
    }
  });
}


export async function deleteCompareAnalysis(
  idA: number,
  idB: number,
  kind: string = "inputs",
): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db.delete(compareAnalyses)
    .where(
      and(
        eq(compareAnalyses.lapAId, lo),
        eq(compareAnalyses.lapBId, hi),
        eq(compareAnalyses.kind, kind),
      ),
    )
    .run();
}
