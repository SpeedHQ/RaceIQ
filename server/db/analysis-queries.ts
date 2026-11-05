import { eq, and, sql } from "drizzle-orm";
import { db, readDb } from "./index"
import { lapAnalyses, compareAnalyses } from "./schema";
import { withDatabaseWrite } from "./write-coordination";
import type { AiUsage } from "@raceiq/shared/integrations/ai/usage";

interface AnalysisRow extends AiUsage {
  analysis: string;
  generationKey?: string | null;
}

/**
 * Get cached AI analysis for a lap. Returns analysis + usage stats or null.
 */

export type AnalysisUsage = AiUsage;

/**
 * Save or replace AI analysis for a lap.
 */

export async function getAnalysis(lapId: number): Promise<AnalysisRow | null> {
  const row = await readDb.select({
    analysis: lapAnalyses.analysis,
    generationKey: lapAnalyses.generationKey,
    inputTokens: lapAnalyses.inputTokens,
    outputTokens: lapAnalyses.outputTokens,
    costUsd: lapAnalyses.costUsd,
    durationMs: lapAnalyses.durationMs,
    model: lapAnalyses.model,
  })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, lapId))
    .get();
  return row ?? null;
}


export async function saveAnalysis(lapId: number, analysis: string, usage: AnalysisUsage, generationKey: string | null = null): Promise<void> {
  const existing = await readDb.select({ id: lapAnalyses.id })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, lapId))
    .get();

  const values = {
    analysis,
    generationKey,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
  };

  if (existing) {
    await withDatabaseWrite(() => db.update(lapAnalyses)
      .set(values)
      .where(eq(lapAnalyses.lapId, lapId))
      .run());
  } else {
    await withDatabaseWrite(() => db.insert(lapAnalyses)
      .values({ lapId, ...values })
      .run());
  }
}

/**
 * Delete cached AI analysis for a lap.
 */

export async function deleteAnalysis(lapId: number): Promise<void> {
  await withDatabaseWrite(() => db.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).run());
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
  const row = await readDb.select({
    analysis: compareAnalyses.analysis,
    generationKey: compareAnalyses.generationKey,
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
  kind: string = "inputs",
  generationKey: string | null = null,
): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  const existing = await readDb.select({ id: compareAnalyses.id })
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
    generationKey,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
  };

  if (existing) {
    await withDatabaseWrite(() => db.update(compareAnalyses)
      .set(values)
      .where(
        and(
          eq(compareAnalyses.lapAId, lo),
          eq(compareAnalyses.lapBId, hi),
          eq(compareAnalyses.kind, kind),
        ),
      )
      .run());
  } else {
    await withDatabaseWrite(() => db.insert(compareAnalyses)
      .values({ lapAId: lo, lapBId: hi, kind, ...values })
      .run());
  }
}


export async function deleteCompareAnalysis(
  idA: number,
  idB: number,
  kind: string = "inputs",
): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await withDatabaseWrite(() => db.delete(compareAnalyses)
    .where(
      and(
        eq(compareAnalyses.lapAId, lo),
        eq(compareAnalyses.lapBId, hi),
        eq(compareAnalyses.kind, kind),
      ),
    )
    .run());
}
