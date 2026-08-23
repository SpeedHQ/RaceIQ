import type { APIRequestContext } from "@playwright/test";
import type { GameId } from "../../../../shared/games/ids";
import { compareEndpoint, getSeededLaps, type SeededLapPair } from "./helpers";

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
  for (const lapA of laps.filter((lap) => lap.isValid)) {
    for (const lapB of laps) {
      if (lapB.id === lapA.id || lapB.lapTime < 30 || lapB.trackOrdinal !== lapA.trackOrdinal || lapB.carOrdinal !== lapA.carOrdinal) {
        continue;
      }
      const pair = { lapA, lapB };
      const response = await request.get(compareEndpoint(pair));
      if (!response.ok()) continue;
      const payload = (await response.json()) as ComparisonPayload;
      const requiredTraces = [
        payload.traces.distance,
        payload.traces.speedA,
        payload.traces.speedB,
        payload.traces.throttleA,
        payload.traces.throttleB,
        payload.traces.brakeA,
        payload.traces.brakeB,
        payload.traces.rpmA,
        payload.traces.rpmB,
      ];
      const hasDistinctSpeed = payload.traces.speedA.some((speed, index) => Math.abs(speed - payload.traces.speedB[index]!) > 0.0001);
      if (requiredTraces.every((trace) => trace.length > 10) && hasDistinctSpeed && payload.timeDelta.some((delta) => Math.abs(delta) > 0.0001)) {
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
    lapA: String(pair.lapA.id),
    laps: String(pair.lapB.id),
    cursor: "7",
  }).toString();
}
