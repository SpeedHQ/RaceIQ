import { UPLOAD_GAME_IDS, type UploadGame } from "./payload";
export type CanonicalEligibility = {
  readonly status: "eligible";
  readonly authority: "raceiq-online-canonical";
  readonly proofId: string;
};

export type EligibleLapCandidate = {
  readonly lapId: number;
  readonly lapTimeMs: number;
  readonly gameId: UploadGame;
  readonly trackId: string;
  readonly carId: string;
  readonly valid: true;
  readonly eligibility: CanonicalEligibility;
};

export type CandidateSelection = {
  readonly selected: EligibleLapCandidate[];
  readonly rejected: { lapId: number | null; reason: "unknown_eligibility" | "invalid_lap" | "unknown_identity" | "invalid_time" }[];
};

/**
 * Select fastest canonical-eligible lap for each service leaderboard key.
 * The caller must obtain eligibility from authoritative canonical service
 * rules; local parser validity or a local catalog match is not a substitute.
 */
export function selectFastestEligibleLaps(candidates: readonly Partial<EligibleLapCandidate>[]): CandidateSelection {
  const fastest = new Map<string, EligibleLapCandidate>();
  const rejected: CandidateSelection["rejected"] = [];
  for (const candidate of candidates) {
    const lapId = Number.isSafeInteger(candidate.lapId) && Number(candidate.lapId) > 0 ? Number(candidate.lapId) : null;
    if (!candidate.eligibility || candidate.eligibility.status !== "eligible" ||
        candidate.eligibility.authority !== "raceiq-online-canonical" ||
        typeof candidate.eligibility.proofId !== "string" || candidate.eligibility.proofId.trim().length === 0) {
      rejected.push({ lapId, reason: "unknown_eligibility" });
      continue;
    }
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
