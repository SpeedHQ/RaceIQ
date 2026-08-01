import { getSessionResult } from "../db/queries";
import { reconcileSessionResult } from "./reconcile";
import type { RaceResult } from "../../shared/race-results";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { GameId } from "../../shared/types";
import type { RaceResultAggregate } from "../../shared/race-results";
import { db } from "../db";
import { pitEvents, sessionResults, sessions } from "../db/schema";

async function reconcileMissingResults(scope: ResultAggregateScope): Promise<void> {
  const filters = [eq(sessions.gameId, scope.gameId), isNull(sessionResults.id)];
  if (scope.carOrdinal != null) filters.push(eq(sessions.carOrdinal, scope.carOrdinal));
  if (scope.trackOrdinal != null) filters.push(eq(sessions.trackOrdinal, scope.trackOrdinal));
  const missing = await db
    .select({ sessionId: sessions.id })
    .from(sessions)
    .leftJoin(sessionResults, eq(sessionResults.sessionId, sessions.id))
    .where(and(...filters))
    .all();
  for (const { sessionId } of missing) {
    await reconcileSessionResult(sessionId, scope.gameId);
  }
}

export interface ResultAggregateScope {
  gameId: GameId;
  carOrdinal?: number;
  trackOrdinal?: number;
}

export async function getRaceResultAggregate(scope: ResultAggregateScope): Promise<RaceResultAggregate> {
  await reconcileMissingResults(scope);
  const filters = [eq(sessions.gameId, scope.gameId)];
  if (scope.carOrdinal != null) filters.push(eq(sessions.carOrdinal, scope.carOrdinal));
  if (scope.trackOrdinal != null) filters.push(eq(sessions.trackOrdinal, scope.trackOrdinal));
  const [row] = await db
    .select({
      sessions: sql<number>`count(${sessionResults.id})`,
      finished: sql<number>`sum(case when ${sessionResults.classification} = 'finished' then 1 else 0 end)`,
      dnf: sql<number>`sum(case when ${sessionResults.classification} = 'dnf' then 1 else 0 end)`,
      retired: sql<number>`sum(case when ${sessionResults.classification} = 'retired' then 1 else 0 end)`,
      qualifying: sql<number>`sum(case when ${sessionResults.classification} = 'qualifying' then 1 else 0 end)`,
      unknown: sql<number>`sum(case when ${sessionResults.classification} = 'unknown' then 1 else 0 end)`,
      podiums: sql<number>`sum(case when ${sessionResults.isPodium} = 1 then 1 else 0 end)`,
      fastestLaps: sql<number>`sum(case when ${sessionResults.isFastestLap} = 1 then 1 else 0 end)`,
      tyreAvailable: sql<number>`sum(case when ${sessionResults.tyreStrategy} is not null then 1 else 0 end)`,
      fuelAvailable: sql<number>`sum(case when ${sessionResults.fuelStrategy} is not null then 1 else 0 end)`,
      pitStops: sql<number>`coalesce(sum(${sessionResults.pitCount}), 0)`,
    })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(and(...filters))
    .all();
  const [pit] = await db
    .select({ duration: sql<number | null>`sum(${pitEvents.durationSeconds})` })
    .from(pitEvents)
    .innerJoin(sessionResults, eq(pitEvents.resultId, sessionResults.id))
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(and(...filters))
    .all();
  const value = (input: number | null | undefined) => Number(input ?? 0);
  return {
    gameId: scope.gameId,
    sessions: value(row?.sessions),
    finished: value(row?.finished),
    dnf: value(row?.dnf),
    retired: value(row?.retired),
    qualifying: value(row?.qualifying),
    unknown: value(row?.unknown),
    podiums: value(row?.podiums),
    fastestLaps: value(row?.fastestLaps),
    pitStops: value(row?.pitStops),
    pitDurationSeconds: pit?.duration == null ? null : Number(pit.duration),
    qualifyingToRaceMovement: null,
    tyreStrategyAvailable: value(row?.tyreAvailable) > 0,
    fuelStrategyAvailable: value(row?.fuelAvailable) > 0,
  };
}

export async function getRecentRaceResults(gameId: GameId, limit = 10): Promise<RaceResult[]> {
  await reconcileMissingResults({ gameId });
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await db
    .select({ sessionId: sessionResults.sessionId })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(eq(sessions.gameId, gameId))
    .orderBy(desc(sessions.id))
    .limit(boundedLimit)
    .all();
  const results: RaceResult[] = [];
  for (const row of rows) {
    const result = await getSessionResult(row.sessionId, gameId);
    if (result) results.push(result as RaceResult);
  }
  return results;
}
