import { and, eq, exists, gt, inArray, isNotNull, lte, notExists, or, sql } from "drizzle-orm";
import { readDb } from "@raceiq/backend-core/db/index";
import { laps, liveCaptures, sessions, strategySessionState, strategyStints } from "@raceiq/backend-core/db/schema";
import { backfillSessionStrategy, SessionRawFileMissingError, type ReprocessResult } from "@raceiq/backend-core/session-capture/reprocess";
import { STRATEGY_ALGORITHM_VERSION } from "./lap-metrics";

/** Rechecked while the source-maintenance lock is held by recording replay. */
export async function needsStrategyBackfill(sessionId: number): Promise<boolean> {
  const existing = await readDb.select({ algorithmVersion: sql<string>`json_extract(${strategyStints.payload}, '$.algorithmVersion')` }).from(strategyStints).where(eq(strategyStints.sessionId, sessionId)).limit(1).get();
  const state = await readDb.select({ generation: strategySessionState.rebuildGeneration }).from(strategySessionState).where(eq(strategySessionState.sessionId, sessionId)).get();
  const capture = await readDb.select({ status: liveCaptures.status }).from(liveCaptures).where(eq(liveCaptures.sessionId, sessionId)).get();
  return ((!existing && state?.generation == null) || !!existing && existing.algorithmVersion !== STRATEGY_ALGORITHM_VERSION)
    && (!capture || !["recording", "finalizing", "recovering"].includes(capture.status));
}

/** One startup pass over sealed recordings; publication owns the maintenance/write locks. */
export async function backfillSessionStrategies(onBackfilled?: (result: ReprocessResult) => void, shouldStop: () => boolean = () => false) {
  const counts = { scanned: 0, backfilled: 0, missingCapture: 0, failed: 0 };
  const upper = await readDb.select({ id: sql<number>`coalesce(max(${sessions.id}), 0)` }).from(sessions).get();
  const upperSessionId = upper?.id ?? 0;
  let afterSessionId = 0;
  while (!shouldStop()) {
    const page = await readDb.select({ id: sessions.id }).from(sessions).where(and(
      gt(sessions.id, afterSessionId), lte(sessions.id, upperSessionId), isNotNull(sessions.rawFile),
      exists(readDb.select({ value: sql`1` }).from(laps).where(eq(laps.sessionId, sessions.id))),
      or(
        and(
          notExists(readDb.select({ value: sql`1` }).from(strategyStints).where(eq(strategyStints.sessionId, sessions.id))),
          notExists(readDb.select({ value: sql`1` }).from(strategySessionState).where(and(
            eq(strategySessionState.sessionId, sessions.id), isNotNull(strategySessionState.rebuildGeneration),
          ))),
        ),
        exists(readDb.select({ value: sql`1` }).from(strategyStints).where(and(
          eq(strategyStints.sessionId, sessions.id), sql`json_extract(${strategyStints.payload}, '$.algorithmVersion') IS NOT ${STRATEGY_ALGORITHM_VERSION}`,
        ))),
      ),
      notExists(readDb.select({ value: sql`1` }).from(liveCaptures).where(and(
        eq(liveCaptures.sessionId, sessions.id), inArray(liveCaptures.status, ["recording", "finalizing", "recovering"]),
      ))),
    )).orderBy(sessions.id).limit(100).all();
    if (page.length === 0) break;
    for (const { id } of page) {
      if (shouldStop()) return counts;
      afterSessionId = id;
      counts.scanned++;
      try {
        const rebuilt = await backfillSessionStrategy(id);
        if (rebuilt) {
          counts.backfilled++;
          onBackfilled?.(rebuilt);
        }
      } catch (error) {
        if (error instanceof SessionRawFileMissingError) counts.missingCapture++;
        else counts.failed++;
        console.warn(`[StrategyBackfill] Session ${id}:`, error);
      }
    }
    if (page.length < 100) break;
  }
  return counts;
}
