import type { SemanticReplayFrame } from "../../hooks/laps";
import { semanticNumber, semanticValues, type SemanticAnalysisFrame } from "../analyse/track-map/types";
import type { TelemetryVariableId } from "../../../../shared/telemetry/catalog/generated/telemetry-catalog.types";

export function semanticSamples(frames: SemanticReplayFrame[] | undefined): SemanticAnalysisFrame[] {
  return (frames ?? []).map((frame) => {
    const values = semanticValues(frame.values.filter((entry) => (entry.state === undefined || entry.state === "ok") && (entry.freshness === undefined || entry.freshness === "fresh")));
    const states: Record<string, string | undefined> = {};
    const freshness: Record<string, string | undefined> = {};
    for (const entry of frame.values) {
      if (entry.state !== undefined) states[entry.semanticId] = entry.state;
      if (entry.freshness !== undefined) freshness[entry.semanticId] = entry.freshness;
    }
    return { values, states, freshness };
  });
}

export function numberValue(frame: SemanticAnalysisFrame, id: TelemetryVariableId): number | undefined {
  return semanticNumber(frame, id) ?? undefined;
}

export function wheelValue(frame: SemanticAnalysisFrame, id: TelemetryVariableId, index: number): number | undefined {
  const value = frame.values[id];
  return Array.isArray(value) && typeof value[index] === "number" && Number.isFinite(value[index]) ? value[index] : undefined;
}
