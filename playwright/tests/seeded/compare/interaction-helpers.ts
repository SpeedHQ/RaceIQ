import type { APIRequestContext } from "@playwright/test";
import type { GameId } from "../../../../shared/games/ids";
import { fetchAlignedSet, getSeededLaps, type SeededLapPair } from "./helpers";

export type ComparisonPayload = {
  traces: {
    distance: number[];
    speedA: number[];
    speedB: number[];
    throttleA: number[];
    throttleB: number[];
    brakeA: number[];
    brakeB: number[];
    rpmA: number[];
    rpmB: number[];
    tireWearA?: number[];
    tireWearB?: number[];
  };
  timeDelta: number[];
};

export async function getDistinctPair(request: APIRequestContext, gameId: GameId): Promise<SeededLapPair> {
  const laps = await getSeededLaps(request, gameId);
  const firstLaps = laps.filter((lap) => lap.isValid);
  const fallbackLaps = laps.filter((lap) => lap.lapTime >= 30);
  for (const lapA of firstLaps.length > 0 ? firstLaps : fallbackLaps) {
    for (const lapB of laps) {
      if (lapB.id === lapA.id || lapB.lapTime < 30 || lapB.trackOrdinal !== lapA.trackOrdinal || lapB.carOrdinal !== lapA.carOrdinal) {
        continue;
      }
      const pair = { lapA, lapB };
      const { set } = await fetchAlignedSet(request, pair);
      if (!set || set.laps.length !== 2) continue;
      const [traceA, traceB] = set.laps;
      const requiredTraces = [
        set.distanceMeters,
        traceA!.speedMps,
        traceB!.speedMps,
        traceA!.throttle,
        traceB!.throttle,
        traceA!.brake,
        traceB!.brake,
        traceA!.rpm,
        traceB!.rpm,
      ];
      const hasDistinctSpeed = traceA!.speedMps.some((speed, index) => Math.abs(speed - traceB!.speedMps[index]!) > 0.0001);
      const hasTimeDelta = traceA!.elapsedTimeS.some((time, index) => Math.abs(time - traceB!.elapsedTimeS[index]!) > 0.0001);
      if (requiredTraces.every((trace) => trace.length > 10) && hasDistinctSpeed && hasTimeDelta) {
        return pair;
      }
    }
  }
  throw new Error(`${gameId} needs two comparable seeded laps on one track/car`);
}

export function compareQuery(pair: SeededLapPair): string {
  return new URLSearchParams({
    track: String(pair.lapA.trackOrdinal),
    carA: String(pair.lapA.carOrdinal),
    carB: String(pair.lapB.carOrdinal),
    lapA: String(pair.lapA.id),
    lapB: String(pair.lapB.id),
    cursor: "7",
  }).toString();
}
