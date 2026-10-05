import type { GameId } from "@raceiq/shared/games/ids";
import {
  carIdentityKey,
  trackIdentityKey,
  type LapMeta,
} from "@raceiq/shared/racing/sessions/types";
import { parseUtcTimestamp } from "../../lib/utc-date";

export interface DashboardInsights {
  clean: { valid: number; total: number; rate: number | null };
  pace: {
    latest: LapMeta;
    best: number;
    previousBest: number | null;
    delta: number | null;
  } | null;
  practice: {
    days: { date: string; seconds: number; laps: number }[];
    activeDays: number;
    totalSeconds: number;
  };
}

function timestamp(lap: LapMeta): number {
  const date = parseUtcTimestamp(lap.createdAt);
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
}

function compareLaps(a: LapMeta, b: LapMeta): number {
  const difference = timestamp(a) - timestamp(b);
  return difference || a.id - b.id;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function canonical(value: number | string | null): string | null {
  return value == null ? null : `${typeof value}:${value}`;
}

export function buildDashboardInsights(
  laps: readonly LapMeta[],
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
    .sort(compareLaps);
  const cleanLaps = eligibleLaps.filter((lap) => positiveFinite(lap.lapTime)).slice(-20);
  const valid = cleanLaps.filter((lap) => lap.isValid).length;

  let latest: LapMeta | undefined;
  for (let index = eligibleLaps.length - 1; index >= 0; index -= 1) {
    const lap = eligibleLaps[index];
    if (lap.gameId != null && carIdentityKey(lap) != null && trackIdentityKey(lap) != null) {
      latest = lap;
      break;
    }
  }


  let pace: DashboardInsights["pace"] = null;
  if (latest) {
    const gameKey = latest.gameId;
    const carKey = canonical(carIdentityKey(latest));
    const trackKey = canonical(trackIdentityKey(latest));
    let best = Number.POSITIVE_INFINITY;
    let previousBest = Number.POSITIVE_INFINITY;
    for (const lap of eligibleLaps) {
      if (lap.gameId !== gameKey
        || canonical(carIdentityKey(lap)) !== carKey
        || canonical(trackIdentityKey(lap)) !== trackKey
        || !lap.isValid
        || !positiveFinite(lap.lapTime)) continue;
      if (lap.sessionId === latest.sessionId) {
        best = Math.min(best, lap.lapTime);
      } else if (compareLaps(lap, latest) < 0) {
        previousBest = Math.min(previousBest, lap.lapTime);
      }
    }
    if (Number.isFinite(best)) {
      const priorBest = Number.isFinite(previousBest) ? previousBest : null;
      pace = { latest, best, previousBest: priorBest, delta: priorBest === null ? null : best - priorBest };
    }
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date: key, seconds: 0, laps: 0 };
  });
  const dayIndex = new Map(days.map((day, index) => [day.date, index]));
  for (const lap of eligibleLaps) {
    if (!positiveFinite(lap.lapTime)) continue;
    const date = new Date(timestamp(lap));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const index = dayIndex.get(key);
    if (index === undefined) continue;
    days[index].seconds += lap.lapTime;
    days[index].laps += 1;
  }
  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);
  const activeDays = days.filter((day) => day.laps > 0).length;

  return {
    clean: { valid, total: cleanLaps.length, rate: cleanLaps.length === 0 ? null : valid / cleanLaps.length },
    pace,
    practice: { days, activeDays, totalSeconds },
  };
}
