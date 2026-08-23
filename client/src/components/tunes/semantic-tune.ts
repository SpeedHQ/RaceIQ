import type { SemanticReplayFrame } from "../../hooks/laps";
import { semanticValues, type SemanticAnalysisFrame } from "@/components/track-map/types";

export interface SemanticTuneSample {
  values: SemanticAnalysisFrame["values"];
}

export function semanticSamples(frames: SemanticReplayFrame[] | undefined): SemanticTuneSample[] {
  return (frames ?? []).map((f) => ({ values: semanticValues(f.values) }));
}

export function numberValue(sample: SemanticTuneSample, id: keyof SemanticTuneSample["values"]): number | undefined {
  const v = sample.values[id];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function wheelValue(sample: SemanticTuneSample, id: keyof SemanticTuneSample["values"], index: number): number | undefined {
  const v = sample.values[id];
  return Array.isArray(v) && typeof v[index] === "number" && Number.isFinite(v[index]) ? v[index] : undefined;
}
