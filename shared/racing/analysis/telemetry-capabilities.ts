import type { AnalysisTelemetryMetric, AnalysisTelemetryModel, GameAdapter } from "../../games/types";

export const DEFAULT_ANALYSIS_TELEMETRY: AnalysisTelemetryModel = {
  balance: { source: "unavailable", reason: "missing-model" },
  gForce: { source: "unavailable", reason: "missing-model" },
  gripDemand: { source: "unavailable", reason: "source-limitation" },
  traction: { source: "unavailable", reason: "source-limitation" },
  tireTemperature: { source: "unavailable", reason: "source-limitation" },
  surface: { source: "unavailable", reason: "source-limitation" },
  slipRatio: { source: "unavailable", reason: "source-limitation" },
  slipAngle: { source: "unavailable", reason: "source-limitation" },
  lateralSlip: { source: "unavailable", reason: "source-limitation" },
  wheelRotation: { source: "unavailable", reason: "source-limitation" },
  tireHealth: { source: "unavailable", reason: "source-limitation" },
  tireWearRate: { source: "unavailable", reason: "source-limitation" },
  tirePressure: { source: "unavailable", reason: "source-limitation" },
  suspensionTravel: { source: "unavailable", reason: "source-limitation" },
  suspensionCompressionBias: { source: "unavailable", reason: "missing-model" },
};

export function resolveAnalysisTelemetry(adapter: GameAdapter | undefined): AnalysisTelemetryModel {
  return {
    ...DEFAULT_ANALYSIS_TELEMETRY,
    ...adapter?.telemetry.analysis,
  };
}

export function hasTireTemperatureData(temperature: readonly number[] | undefined, metric: AnalysisTelemetryMetric): boolean {
  if (metric.source !== "direct" || metric.freshness !== "pit-snapshot") {
    return metric.source !== "unavailable";
  }
  return temperature?.some((value) => Number.isFinite(value) && value !== 0) ?? false;
}

export function hasTireHealthData(wear: readonly number[] | undefined, metric: AnalysisTelemetryMetric): boolean {
  if (metric.source !== "direct" || metric.freshness !== "pit-snapshot") {
    return metric.source !== "unavailable";
  }
  return wear?.some((value) => Number.isFinite(value) && value !== 0) ?? false;
}
