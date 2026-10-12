import { expect, type APIRequestContext, type Response } from "@playwright/test";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { decodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import type { EncodedAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/types";

export interface SeededLapMeta extends LapMeta {
  trackId: string;
  carId: string;
  lapNumber: number;
}

export type SeededLapPair = {
  lapA: SeededLapMeta;
  lapB: SeededLapMeta;
};

export type TrackCarLapPair = SeededLapPair & {
  trackId: string;
  carId: string;
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
    const byTrack = new Map<string, Map<string, SeededLapMeta[]>>();
    for (const lap of laps) {
      if (!lap.trackId || !lap.carId || (requireValid && !lap.isValid)) continue;
      let cars = byTrack.get(lap.trackId);
      if (!cars) {
        cars = new Map();
        byTrack.set(lap.trackId, cars);
      }
      const list = cars.get(lap.carId) ?? [];
      list.push(lap);
      cars.set(lap.carId, list);
    }

    const tracks = Array.from(byTrack.keys()).sort();
    for (const trackId of tracks) {
      const cars = byTrack.get(trackId);
      if (!cars) continue;
      const carIds = Array.from(cars.keys()).sort();
      for (const carId of carIds) {
        const candidate = cars.get(carId)?.slice().sort((a, b) => a.lapNumber - b.lapNumber || a.id - b.id) ?? [];
        if (candidate.length >= 2) return { trackId, carId, lapA: candidate[0], lapB: candidate[1] };
      }
    }
    return null;
  };

  // Prefer clean laps; invalid complete recordings remain useful for
  // deterministic compare UI coverage when no clean pair exists.
  return findPair(true) ?? findPair(false);
}

export function getFirstSeededLap(laps: readonly SeededLapMeta[]): SeededLapMeta | null {
  return laps.filter((lap) => lap.trackId !== undefined && lap.carId !== undefined).sort((a, b) => a.id - b.id)[0] ?? null;
}

export const ALIGNED_TELEMETRY_ENDPOINT = "/api/laps/aligned-telemetry";

export function alignedRequestMatches(response: Response, idA: number, idB: number, step: 1 | 0.1): boolean {
  if (response.request().method() !== "POST" || new URL(response.url()).pathname !== ALIGNED_TELEMETRY_ENDPOINT) return false;
  const body = response.request().postDataJSON() as { ids?: number[]; step?: number } | null;
  return body?.step === step && body.ids?.length === 2 && body.ids[0] === idA && body.ids[1] === idB;
}

export async function fetchAlignedSet(
  request: APIRequestContext,
  pair: SeededLapPair,
  detail?: { start: number; end: number },
) {
  const response = await request.post(ALIGNED_TELEMETRY_ENDPOINT, {
    data: detail
      ? { ids: [pair.lapA.id, pair.lapB.id], step: 0.1, start: detail.start, end: detail.end }
      : { ids: [pair.lapA.id, pair.lapB.id], step: 1 },
  });
  if (!response.ok()) return { response, set: null };
  const set = decodeAlignedLapSet((await response.json()) as EncodedAlignedLapSet);
  return { response, set };
}

export async function getSeededLaps(request: APIRequestContext, gameId: GameId): Promise<SeededLapMeta[]> {
  const response = await request.get(`/api/laps?gameId=${gameId}`);
  expect(response.ok(), `seeded lap list for ${gameId}`).toBe(true);
  const laps = (await response.json()) as SeededLapMeta[];
  expect(laps.length, `seeded laps for ${gameId}`).toBeGreaterThan(0);
  return laps;
}
