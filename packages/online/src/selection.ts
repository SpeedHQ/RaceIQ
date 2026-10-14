import { UPLOAD_GAME_IDS, type UploadGame } from "./payload";
export type EligibleLapCandidate = {
  readonly lapId: number;
  readonly lapTimeMs: number;
  readonly gameId: UploadGame;
  readonly trackId: string;
  readonly carId: string;
  readonly valid: true;
};

export type CandidateSelection = {
  readonly selected: EligibleLapCandidate[];
  readonly rejected: { lapId: number | null; reason: "invalid_lap" | "unknown_identity" | "invalid_time" }[];
};

/** Select fastest locally admissible lap per game/track; server remains authoritative. */
export function selectFastestEligibleLaps(candidates: readonly Partial<EligibleLapCandidate>[]): CandidateSelection {
  const fastest = new Map<string, EligibleLapCandidate>();
  const rejected: CandidateSelection["rejected"] = [];
  for (const candidate of candidates) {
    const lapId = Number.isSafeInteger(candidate.lapId) && Number(candidate.lapId) > 0 ? Number(candidate.lapId) : null;
    if (candidate.valid !== true) {
      rejected.push({ lapId, reason: "invalid_lap" });
      continue;
    }
    if (!UPLOAD_GAME_IDS.includes(candidate.gameId as UploadGame) ||
        !candidate.trackId || !candidate.carId ||
        candidate.trackId.length > 256 || candidate.carId.length > 256) {
      rejected.push({ lapId, reason: "unknown_identity" });
      continue;
    }
    if (lapId == null || !Number.isSafeInteger(candidate.lapTimeMs) || Number(candidate.lapTimeMs) <= 0) {
      rejected.push({ lapId, reason: "invalid_time" });
      continue;
    }
    const key = JSON.stringify([candidate.gameId, candidate.trackId]);
    const prior = fastest.get(key);
    if (!prior || Number(candidate.lapTimeMs) < prior.lapTimeMs) {
      fastest.set(key, candidate as EligibleLapCandidate);
    }
  }
  return { selected: [...fastest.values()], rejected };
}
