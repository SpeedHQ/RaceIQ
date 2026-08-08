import type { SemanticReplayFrame } from "../../hooks/laps";

export interface SemanticTuneSample { values: Readonly<Record<string, unknown>> }
export function semanticSamples(frames: SemanticReplayFrame[] | undefined): SemanticTuneSample[] {
  return (frames ?? []).map((f) => ({ values: Object.fromEntries(f.values.map((v) => [v.semanticId, v.value])) }));
}
export function numberValue(sample: SemanticTuneSample, id: string): number | undefined {
  const v = sample.values[id]; return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function wheelValue(sample: SemanticTuneSample, id: string, index: number): number | undefined {
  const v = sample.values[id]; return Array.isArray(v) && typeof v[index] === "number" && Number.isFinite(v[index]) ? v[index] : undefined;
}
