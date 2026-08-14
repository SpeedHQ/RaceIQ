import { getRecentSessionResults, loadRaceResultLapQuality } from "../db/session-result-queries";
import type { RaceResult, RaceResultEligibilityStatusCounts, RaceResultLapQualityEvidence, RaceResultPolicyQualityAggregate } from "../../shared/racing/results/types";
import { and, eq, sql } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import type { RaceResultAggregate } from "../../shared/racing/results/types";
import { db } from "../db";
import { pitEvents, sessionResults, sessions } from "../db/schema";

// Results are materialized when a session completes or through explicit
// backfill. Read endpoints never derive incomplete live sessions.
export interface ResultAggregateScope {
  gameId: GameId;
  carOrdinal?: number;
  trackOrdinal?: number;
}
function summarizePolicyQuality(evidence: readonly RaceResultLapQualityEvidence[], policy: "officialTiming" | "normalPace"): RaceResultPolicyQualityAggregate {
  const statuses: RaceResultEligibilityStatusCounts = {
    eligible: 0,
    eligible_with_warning: 0,
    ineligible: 0,
    unknown: 0,
  };
  const reasons: RaceResultPolicyQualityAggregate["reasons"] = {};
  for (const lap of evidence) {
    const decision = lap[policy];
    statuses[decision.status] += 1;
    for (const reason of decision.reasons) {
      reasons[reason.code] = (reasons[reason.code] ?? 0) + 1;
    }
  }
  return { statuses, reasons };
}

export async function getRaceResultAggregate(scope: ResultAggregateScope): Promise<RaceResultAggregate> {
  const filters = [eq(sessions.gameId, scope.gameId)];
  if (scope.carOrdinal != null) filters.push(eq(sessions.carOrdinal, scope.carOrdinal));
  if (scope.trackOrdinal != null) filters.push(eq(sessions.trackOrdinal, scope.trackOrdinal));
  const [row] = await db
    .select({
      sessions: sql<number>`count(${sessionResults.id})`,
      finished: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.classification} = 'finished' then 1 else 0 end)`,
      dnf: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.classification} = 'dnf' then 1 else 0 end)`,
      retired: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.classification} = 'retired' then 1 else 0 end)`,
      disqualified: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.classification} = 'disqualified' then 1 else 0 end)`,
      notClassified: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.classification} = 'not-classified' then 1 else 0 end)`,
      qualifying: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.classification} = 'qualifying' then 1 else 0 end)`,
      unknown: sql<number>`sum(case when ${sessionResults.classification} = 'unknown' then 1 else 0 end)`,
      confirmed: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' then 1 else 0 end)`,
      provisional: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'provisional' then 1 else 0 end)`,
      unavailable: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'unavailable' then 1 else 0 end)`,
      podiums: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.isPodium} = 1 then 1 else 0 end)`,
      fastestLaps: sql<number>`sum(case when ${sessionResults.outcomeStatus} = 'confirmed' and ${sessionResults.isFastestLap} = 1 then 1 else 0 end)`,
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
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessionResults)
    .innerJoin(sessions, eq(sessionResults.sessionId, sessions.id))
    .where(and(...filters))
    .all();
  const lapQualityBySession = await loadRaceResultLapQuality(sessionRows.map(({ id }) => id));
  const lapQuality = sessionRows.flatMap(({ id }) => lapQualityBySession.get(id) ?? []);
  const value = (input: number | null | undefined) => Number(input ?? 0);
  return {
    gameId: scope.gameId,
    sessions: value(row?.sessions),
    finished: value(row?.finished),
    dnf: value(row?.dnf),
    retired: value(row?.retired),
    disqualified: value(row?.disqualified),
    notClassified: value(row?.notClassified),
    qualifying: value(row?.qualifying),
    unknown: value(row?.unknown),
    confirmed: value(row?.confirmed),
    provisional: value(row?.provisional),
    unavailable: value(row?.unavailable),
    podiums: value(row?.podiums),
    fastestLaps: value(row?.fastestLaps),
    pitStops: value(row?.pitStops),
    pitDurationSeconds: pit?.duration == null ? null : Number(pit.duration),
    qualifyingToRaceMovement: null,
    tyreStrategyAvailable: value(row?.tyreAvailable) > 0,
    fuelStrategyAvailable: value(row?.fuelAvailable) > 0,
    lapQuality: {
      total: lapQuality.length,
      officialTiming: summarizePolicyQuality(lapQuality, "officialTiming"),
      normalPace: summarizePolicyQuality(lapQuality, "normalPace"),
    },
  };
}

export async function getRecentRaceResults(gameId: GameId, limit = 10): Promise<RaceResult[]> {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  return (await getRecentSessionResults(gameId, boundedLimit)) as RaceResult[];
}
