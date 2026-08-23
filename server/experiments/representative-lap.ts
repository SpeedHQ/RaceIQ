/** Representative lap and derived setup-engineer context for an experiment. */
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { EligibilityDecision, QualityReasonCode } from "../../shared/racing/quality/contracts";
import { selectEvaluationLaps } from "../../shared/racing/laps/review-selection";
import { getLapsForExperiment } from "../db/experiment-lap-queries";
import { resolveSemanticLapCorners } from "../tracks/corner-resolution";
import { queryLapTelemetryBySemanticId } from "../telemetry/replay";
import { semanticSamplesFromReplay } from "../telemetry/semantic-samples";
import { telemetryToSymptoms, TUNE_SYMPTOM_SEMANTIC_IDS, type TuneSymptoms } from "../ai/tune-symptoms";
import { telemetryToTrackConditions, TRACK_CONDITION_SEMANTIC_IDS, type TrackConditions } from "../ai/track-conditions";
import { MIN_TELEMETRY_FRAMES } from "./lap-policy";

/** Exact semantic evidence required for representative-lap diagnosis. */
export const REPRESENTATIVE_LAP_SEMANTIC_IDS = [...TUNE_SYMPTOM_SEMANTIC_IDS, ...TRACK_CONDITION_SEMANTIC_IDS] as const;

export type RepresentativeLap = LapMeta;

export interface RepresentativeLapSelection {
  lap: RepresentativeLap | null;
  setupDecision: EligibilityDecision;
  reasonCodes: QualityReasonCode[];
}

export interface RepresentativeLapTelemetry {
  lap: RepresentativeLap;
  samples: SemanticTelemetrySample[];
}

/**
 * Load representative metadata together with exact setup-analysis policy
 * result. Semantic replay below enforces the minimum-frame rule from resolver
 * envelope/sample counts before any analysis consumes the lap.
 */
export async function loadRepresentativeLapSelection(experimentId: number): Promise<RepresentativeLapSelection> {
  const sessionLaps = await getLapsForExperiment(experimentId);
  const selection = selectEvaluationLaps(sessionLaps, Number.POSITIVE_INFINITY);
  const reasonCodes = selection.setupDecision.reasons.map((reason) => reason.code);
  const best = selection.chosen[0];
  if (!best) return { lap: null, setupDecision: selection.setupDecision, reasonCodes };
  return { lap: best, setupDecision: selection.setupDecision, reasonCodes };
}

/** Fastest policy-selected lap, or null when evidence is unavailable. */
export async function loadRepresentativeLap(experimentId: number): Promise<RepresentativeLap | null> {
  return (await loadRepresentativeLapSelection(experimentId)).lap;
}

/** Replay one representative lap through requested semantic resolver slots. */
export async function loadRepresentativeLapTelemetry(experimentId: number, semanticIds: readonly string[] = REPRESENTATIVE_LAP_SEMANTIC_IDS): Promise<RepresentativeLapTelemetry | null> {
  const lap = await loadRepresentativeLap(experimentId);
  if (!lap || !lap.gameId) return null;
  const replay = await queryLapTelemetryBySemanticId(lap.id, semanticIds);
  if (!replay) return null;
  const samples = semanticSamplesFromReplay(replay);
  if (samples.length < MIN_TELEMETRY_FRAMES) return null;
  return { lap, samples };
}

/** Deterministic symptom report for the experiment's representative lap. */
export async function computeSessionSymptoms(experimentId: number): Promise<TuneSymptoms | null> {
  const representative = await loadRepresentativeLapTelemetry(experimentId);
  if (!representative || !representative.lap.gameId) return null;
  const corners = await resolveSemanticLapCorners(representative.lap.trackOrdinal, representative.lap.gameId, representative.samples);
  return telemetryToSymptoms(representative.lap.gameId, representative.samples, corners);
}

/** Deterministic weather/track-surface context for the representative lap. */
export async function computeSessionTrackConditions(experimentId: number): Promise<TrackConditions | null> {
  const representative = await loadRepresentativeLapTelemetry(experimentId, TRACK_CONDITION_SEMANTIC_IDS);
  return representative ? telemetryToTrackConditions(representative.samples) : null;
}
