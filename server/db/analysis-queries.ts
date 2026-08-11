import { eq, and, inArray, sql } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION } from "../../shared/racing/quality/contracts";
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
interface QualityCacheIdentity {
  generation: string;
  policyVersion: string;
}

async function getLapQualityIdentity(lapId: number): Promise<QualityCacheIdentity | null> {
  const row = await db
    .select({
      generation: laps.qualityGeneration,
      policyVersion: laps.qualityPolicyVersion,
    })
    .from(laps)
    .where(eq(laps.id, lapId))
    .get();
  return row?.generation && row.policyVersion ? { generation: row.generation, policyVersion: row.policyVersion } : null;
}

async function getCompareQualityIdentity(idA: number, idB: number): Promise<QualityCacheIdentity | null> {
  const rows = await db
    .select({
      id: laps.id,
      generation: laps.qualityGeneration,
      policyVersion: laps.qualityPolicyVersion,
    })
    .from(laps)
    .where(inArray(laps.id, [idA, idB]))
    .all();
  if (rows.length !== 2 || rows.some(({ generation }) => !generation)) return null;
  if (rows.some(({ policyVersion }) => policyVersion !== ELIGIBILITY_POLICY_VERSION)) return null;
  return {
    generation: combineQualityGenerations(rows.map(({ generation }) => generation!)),
    policyVersion: ELIGIBILITY_POLICY_VERSION,
  };
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

export async function getAnalysis(lapId: number): Promise<AnalysisRow | null> {
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
    .where(and(eq(lapAnalyses.lapId, lapId), eq(lapAnalyses.qualityGeneration, identity.generation), eq(lapAnalyses.qualityPolicyVersion, identity.policyVersion)))
    .get();
  return row ?? null;
}

export async function saveAnalysis(lapId: number, analysis: string, usage: AnalysisUsage): Promise<void> {
  const existing = await db.select({ id: lapAnalyses.id }).from(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).get();

  const identity = await getLapQualityIdentity(lapId);
  if (!identity) throw new Error(`Lap ${lapId} has no quality generation`);
  const values = {
    analysis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
    qualityGeneration: identity.generation,
    qualityPolicyVersion: identity.policyVersion,
  };

  if (existing) {
    await db.update(lapAnalyses).set(values).where(eq(lapAnalyses.lapId, lapId)).run();
  } else {
    await db
      .insert(lapAnalyses)
      .values({ lapId, ...values })
      .run();
  }
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

export async function getCompareAnalysis(idA: number, idB: number, kind: string = "inputs"): Promise<AnalysisRow | null> {
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
      ),
    )
    .get();
  return row ?? null;
}

export async function saveCompareAnalysis(idA: number, idB: number, analysis: string, usage: AnalysisUsage, kind: string = "inputs"): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  const existing = await db
    .select({ id: compareAnalyses.id })
    .from(compareAnalyses)
    .where(and(eq(compareAnalyses.lapAId, lo), eq(compareAnalyses.lapBId, hi), eq(compareAnalyses.kind, kind)))
    .get();
  const identity = await getCompareQualityIdentity(lo, hi);
  if (!identity) throw new Error("Compared laps have no current quality generation");

  const values = {
    analysis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
    qualityGeneration: identity.generation,
    qualityPolicyVersion: identity.policyVersion,
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
}

export async function deleteCompareAnalysis(idA: number, idB: number, kind: string = "inputs"): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db
    .delete(compareAnalyses)
    .where(and(eq(compareAnalyses.lapAId, lo), eq(compareAnalyses.lapBId, hi), eq(compareAnalyses.kind, kind)))
    .run();
}
