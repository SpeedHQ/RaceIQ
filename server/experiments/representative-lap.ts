/** Representative lap and derived setup-engineer context for an experiment. */
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getLapById } from "../db/lap-read-queries";
import { resolveLapCorners } from "../tracks/corner-resolution";
import { getLapsForExperiment } from "../db/experiment-lap-queries";
import { telemetryToSymptoms, type TuneSymptoms } from "../ai/tune-symptoms";
import { telemetryToTrackConditions, type TrackConditions } from "../ai/track-conditions";
import { MIN_TELEMETRY_FRAMES } from "./lap-policy";

export type RepresentativeLap = LapMeta & {
  telemetry: TelemetryPacket[];
  parseError?: string;
};

/**
 * The session's representative lap — the fastest valid lap it owns, with enough
 * telemetry to analyse (≥30 frames). Single source of truth so symptom and
 * track-condition reads always describe the same lap. Returns null when no such
 * lap exists yet.
 */
export async function loadRepresentativeLap(
  experimentId: number,
): Promise<RepresentativeLap | null> {
  const sessionLaps = await getLapsForExperiment(experimentId);
  let best: (typeof sessionLaps)[number] | null = null;
  for (const lap of sessionLaps) {
    if (!lap.isValid || lap.lapTime <= 0) continue;
    if (best == null || lap.lapTime < best.lapTime) best = lap;
  }
  if (!best) return null;

  const lap = await getLapById(best.id);
  if (!lap || lap.telemetry.length < MIN_TELEMETRY_FRAMES) return null;
  return lap;
}

/** Deterministic symptom report for the experiment's representative lap. */
export async function computeSessionSymptoms(experimentId: number): Promise<TuneSymptoms | null> {
  const lap = await loadRepresentativeLap(experimentId);
  if (!lap) return null;
  const corners = await resolveLapCorners(lap.trackOrdinal, lap.gameId, lap.telemetry);
  return telemetryToSymptoms(lap.telemetry, corners);
}

/** Deterministic weather/track-surface context for the representative lap. */
export async function computeSessionTrackConditions(experimentId: number): Promise<TrackConditions | null> {
  const lap = await loadRepresentativeLap(experimentId);
  if (!lap) return null;
  return telemetryToTrackConditions(lap.telemetry);
}
