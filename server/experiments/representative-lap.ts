/** Representative lap and derived setup-engineer context for an experiment. */
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { EligibilityDecision, QualityReasonCode } from "../../shared/racing/quality/contracts";
import { selectEvaluationLaps } from "../../shared/racing/laps/review-selection";
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
export interface RepresentativeLapSelection {
  lap: RepresentativeLap | null;
  setupDecision: EligibilityDecision;
  reasonCodes: QualityReasonCode[];
}

/**
 * Load the representative lap together with the exact setup-analysis policy
 * result that selected or rejected it. This keeps machine-readable reasons
 * available to AI/tool consumers instead of collapsing rejection to `null`.
 */
export async function loadRepresentativeLapSelection(experimentId: number): Promise<RepresentativeLapSelection> {
  const sessionLaps = await getLapsForExperiment(experimentId);
  const selection = selectEvaluationLaps(sessionLaps, Number.POSITIVE_INFINITY);
  const reasonCodes = selection.setupDecision.reasons.map((reason) => reason.code);
  const best = selection.chosen[0];
  if (!best) return { lap: null, setupDecision: selection.setupDecision, reasonCodes };

  const lap = await getLapById(best.id);
  if (!lap || lap.telemetry.length < MIN_TELEMETRY_FRAMES) {
    return { lap: null, setupDecision: selection.setupDecision, reasonCodes };
  }
  return { lap, setupDecision: selection.setupDecision, reasonCodes };
}

/** Fastest policy-selected lap, or null when evidence is unavailable. */
export async function loadRepresentativeLap(experimentId: number): Promise<RepresentativeLap | null> {
  return (await loadRepresentativeLapSelection(experimentId)).lap;
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
