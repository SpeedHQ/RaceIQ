import { expect, type APIRequestContext } from "@playwright/test";
import type { GameId } from "../../../../shared/games/ids";
import type { LapMeta } from "../../../../shared/racing/sessions/types";

export interface SeededLapMeta extends LapMeta {
  trackOrdinal: number;
  carOrdinal: number;
  lapNumber: number;
}

export type SeededLapPair = {
  lapA: SeededLapMeta;
  lapB: SeededLapMeta;
};

export type TrackCarLapPair = SeededLapPair & {
  trackOrdinal: number;
  carOrdinal: number;
};

export function formatLapTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

export function lapOptionLabel(lap: SeededLapMeta): string {
  const ownership = lap.ownership === "others" ? "Others" : "Mine";
  return `Lap ${lap.lapNumber} — ${formatLapTime(lap.lapTime)} — ${ownership}${lap.isValid ? "" : " (inv)"}`;
}

export function findTrackCarPairWithTwoLaps(laps: readonly SeededLapMeta[]): TrackCarLapPair | null {
  const findPair = (requireValid: boolean): TrackCarLapPair | null => {
    const byTrack = new Map<number, Map<number, SeededLapMeta[]>>();
    for (const lap of laps) {
      if (!lap.trackOrdinal || !lap.carOrdinal || (requireValid && !lap.isValid)) continue;
      let cars = byTrack.get(lap.trackOrdinal);
      if (!cars) {
        cars = new Map();
        byTrack.set(lap.trackOrdinal, cars);
      }
      const list = cars.get(lap.carOrdinal) ?? [];
      list.push(lap);
      cars.set(lap.carOrdinal, list);
    }

    const tracks = Array.from(byTrack.keys()).sort((a, b) => a - b);
    for (const trackOrdinal of tracks) {
      const cars = byTrack.get(trackOrdinal);
      if (!cars) continue;
      const carOrdinals = Array.from(cars.keys()).sort((a, b) => a - b);
      for (const carOrdinal of carOrdinals) {
        const candidate = cars.get(carOrdinal)?.slice().sort((a, b) => a.lapNumber - b.lapNumber || a.id - b.id) ?? [];
        if (candidate.length >= 2) return { trackOrdinal, carOrdinal, lapA: candidate[0], lapB: candidate[1] };
      }
    }
    return null;
  };

  // Prefer clean laps; invalid complete recordings remain useful for
  // deterministic compare UI coverage when no clean pair exists.
  return findPair(true) ?? findPair(false);
}

export function getFirstSeededLap(laps: readonly SeededLapMeta[]): SeededLapMeta | null {
  return laps.filter((lap) => lap.trackOrdinal !== undefined && lap.carOrdinal !== undefined).sort((a, b) => a.id - b.id)[0] ?? null;
}

export function comparePath(idA: number, idB: number): RegExp {
  return new RegExp(`^/api/laps/${idA}/compare/${idB}$`);
}

export function compareEndpoint(pair: SeededLapPair): string {
  return `/api/laps/${pair.lapA.id}/compare/${pair.lapB.id}`;
}

export async function getSeededLaps(request: APIRequestContext, gameId: GameId): Promise<SeededLapMeta[]> {
  const response = await request.get(`/api/laps?gameId=${gameId}`);
  expect(response.ok(), `seeded lap list for ${gameId}`).toBe(true);
  const laps = (await response.json()) as SeededLapMeta[];
  expect(laps.length, `seeded laps for ${gameId}`).toBeGreaterThan(0);
  return laps;
}
