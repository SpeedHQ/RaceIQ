import type {
  AnalysisTelemetryModel,
  GameAdapter,
} from "./types";

const directContinuous = {
  source: "direct",
  freshness: "continuous",
} as const;
const derivedHigh = {
  source: "derived",
  confidence: "high",
} as const;

/**
 * Existing cross-game behavior. Adapters override source limitations and
 * different freshness/display semantics instead of components checking IDs or
 * treating zero as "unsupported".
 */
export const DEFAULT_ANALYSIS_TELEMETRY: AnalysisTelemetryModel = {
  balance: derivedHigh,
  gForce: { source: "derived", confidence: "exact" },
  gripDemand: { ...derivedHigh, display: "per-wheel" },
  traction: { ...derivedHigh, display: "per-wheel" },
  tireTemperature: { ...directContinuous, display: "per-wheel" },
  surface: { ...directContinuous, display: "per-wheel" },
  slipRatio: { ...derivedHigh, display: "per-wheel" },
  slipAngle: { ...directContinuous, display: "per-wheel" },
  wheelRotation: { ...directContinuous, display: "per-wheel" },
  tireHealth: { ...directContinuous, display: "per-wheel" },
  tireWearRate: { ...derivedHigh, display: "per-wheel" },
  tirePressure: { ...directContinuous, display: "per-wheel" },
  suspensionTravel: { ...directContinuous, display: "normalized" },
  suspensionCompressionBias: {
    source: "derived",
    confidence: "exact",
    display: "compression-bias",
  },
};

export function resolveAnalysisTelemetry(
  adapter: GameAdapter | undefined,
): AnalysisTelemetryModel {
  return {
    ...DEFAULT_ANALYSIS_TELEMETRY,
    ...adapter?.telemetry?.analysis,
  };
}
