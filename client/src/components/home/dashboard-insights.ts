import type { GameId } from "@raceiq/shared/games/ids";
import { isPracticeSession } from "@raceiq/shared/racing/sessions/session-type";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { parseUtcTimestamp } from "../../lib/utc-date";

export interface DashboardInsights {
  clean: { valid: number; total: number; rate: number | null };
  podiums: { total: number; first: number; second: number; third: number; available: boolean };
}

function timestamp(lap: LapMeta): number {
  const date = parseUtcTimestamp(lap.createdAt);
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validPosition(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function buildDashboardInsights(
  laps: readonly LapMeta[],
  sessions: readonly SessionMeta[],
  gameId: GameId | null,
  now = new Date(),
): DashboardInsights {
  const nowTime = now.getTime();
  const eligibleLaps = laps
    .filter((lap) => lap.ownership !== "others" && (gameId === null || lap.gameId === gameId))
    .filter((lap) => {
      const time = timestamp(lap);
      return Number.isFinite(time) && time <= nowTime;
    })
    .sort((a, b) => timestamp(a) - timestamp(b) || a.id - b.id);
  const cleanLaps = eligibleLaps.filter((lap) => positiveFinite(lap.lapTime)).slice(-20);
  const valid = cleanLaps.filter((lap) => lap.isValid).length;

  const seenSessions = new Set<number>();
  let first = 0;
  let second = 0;
  let third = 0;
  let available = false;
  for (const session of sessions) {
    if (
      session.ownership === "others" ||
      (gameId !== null && session.gameId !== gameId) ||
      session.resultOutcomeStatus !== "confirmed" ||
      session.resultClassification !== "finished"
    ) continue;
    if (seenSessions.has(session.id)) continue;
    seenSessions.add(session.id);
    const date = parseUtcTimestamp(session.createdAt);
    if (!Number.isFinite(date.getTime()) || date.getTime() > nowTime) continue;
    const sessionType = session.sessionType?.trim().toLowerCase();
    if (isPracticeSession(sessionType) || !sessionType?.startsWith("race") || !validPosition(session.finishingPosition)) continue;
    available = true;
    if (session.finishingPosition === 1) first += 1;
    else if (session.finishingPosition === 2) second += 1;
    else if (session.finishingPosition === 3) third += 1;
  }
  return {
    clean: { valid, total: cleanLaps.length, rate: cleanLaps.length === 0 ? null : valid / cleanLaps.length },
    podiums: { total: first + second + third, first, second, third, available },
  };
}
