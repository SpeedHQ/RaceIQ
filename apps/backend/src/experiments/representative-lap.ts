/** Representative lap and derived setup-engineer context for an experiment. */
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { resolveLapCorners } from "../tracks/corner-resolution";
import { getLapsForExperiment } from "@raceiq/backend-core/db/experiment-lap-queries";
import { telemetryToSymptoms, type TuneSymptoms } from "@raceiq/backend-core/ai/tune-symptoms";
import { telemetryToTrackConditions, type TrackConditions } from "@raceiq/backend-core/ai/track-conditions";
import { MIN_TELEMETRY_FRAMES } from "@raceiq/backend-core/experiments/lap-policy";
import { medianSorted, percentileSorted } from "@raceiq/backend-core/experiments/statistics";

export type RepresentativeLap = LapMeta & {
  telemetry: TelemetryPacket[];
  parseError?: string;
};

/**
 * Select the fastest eligible lap, excluding user exclusions and statistical
 * outliers before telemetry availability is considered.
 */
export async function loadRepresentativeLap(
  experimentId: number,
  opts?: { lapIds?: readonly number[] },
): Promise<RepresentativeLap | null> {
  const allowed = opts?.lapIds == null ? null : new Set(opts.lapIds);
  const sessionLaps = await getLapsForExperiment(experimentId);
  const candidates = sessionLaps.filter((lap) =>
    (!allowed || allowed.has(lap.id))
    && lap.isValid === true
    && lap.lapTime > 0
    && lap.experimentExcluded !== true
  );
  const times = candidates.map((lap) => lap.lapTime).sort((a, b) => a - b);
  const bestTime = times[0] ?? 0;
  const iqr = percentileSorted(times, 0.75) - percentileSorted(times, 0.25);
  const threshold = Math.max(medianSorted(times) + 1.5 * iqr, bestTime * 1.02);
  const best = candidates
    .filter((lap) => times.length <= 1 || lap.lapTime <= threshold)
    .sort((a, b) => a.lapTime - b.lapTime)[0];
  if (!best) return null;

  const lap = await getLapById(best.id);
  if (!lap || lap.telemetry.length < MIN_TELEMETRY_FRAMES) return null;
  return lap;
}

/** Deterministic symptom report for the experiment's representative lap. */
export async function computeSessionSymptoms(
  experimentId: number,
  opts?: { lapIds?: readonly number[] },
): Promise<TuneSymptoms | null> {
  const lap = await loadRepresentativeLap(experimentId, opts);
  if (!lap) return null;
  const corners = await resolveLapCorners(lap.trackOrdinal, lap.gameId, lap.telemetry);
  return telemetryToSymptoms(lap.telemetry, corners);
}

/** Deterministic weather/track-surface context for the representative lap. */
export async function computeSessionTrackConditions(
  experimentId: number,
  opts?: { lapIds?: readonly number[] },
): Promise<TrackConditions | null> {
  const lap = await loadRepresentativeLap(experimentId, opts);
  if (!lap) return null;
  return telemetryToTrackConditions(lap.telemetry);
}
