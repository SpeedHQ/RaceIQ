import { getSessionResult, getSessions } from "../db/queries";
import type { RaceResult } from "../../shared/race-results";
import { and, eq, sql } from "drizzle-orm";
import type { GameId } from "../../shared/types";
import type { RaceResultAggregate } from "../../shared/race-results";
import { db } from "../db";
import { pitEvents, sessionResults, sessions } from "../db/schema";

export interface ResultAggregateScope {
  gameId: GameId;
  carOrdinal?: number;
  trackOrdinal?: number;
}

export async function getRaceResultAggregate(scope: ResultAggregateScope): Promise<RaceResultAggregate> {
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
  const sessions = (await getSessions(gameId)).slice(0, Math.max(1, Math.min(50, Math.trunc(limit))));
  const results: RaceResult[] = [];
  for (const session of sessions) {
    const result = await getSessionResult(session.id, gameId);
    if (!result) continue;
    results.push(result as RaceResult);
  }
  return results;
}
