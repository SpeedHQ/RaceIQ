import type { TelemetryPacket } from "../../telemetry/types";
import type {
  AnalysisTelemetryMetric,
  AnalysisTelemetryModel,
  GameAdapter,
} from "../../games/types";

const directContinuous = {
  source: "direct",
  freshness: "continuous",
} as const;
const derivedHigh = {
  source: "derived",
  confidence: "high",
} as const;

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
    ...adapter?.telemetry.analysis,
  };
}

export function hasTireTemperatureData(
  packet: TelemetryPacket,
  metric: AnalysisTelemetryMetric,
): boolean {
  if (
    metric.source !== "direct" ||
    metric.freshness !== "pit-snapshot"
  ) {
    return metric.source !== "unavailable";
  }
  return (
    packet.iracing?.pitTireTemperatureAvailable ??
    [
      packet.TireCarcassTempFL,
      packet.TireCarcassTempFR,
      packet.TireCarcassTempRL,
      packet.TireCarcassTempRR,
    ].some((value) => typeof value === "number" && value !== 0)
  );
}

export function hasTireHealthData(
  packet: TelemetryPacket,
  metric: AnalysisTelemetryMetric,
): boolean {
  if (
    metric.source !== "direct" ||
    metric.freshness !== "pit-snapshot"
  ) {
    return metric.source !== "unavailable";
  }
  return (
    packet.iracing?.pitTireWearAvailable ??
    [
      packet.TireWearFL,
      packet.TireWearFR,
      packet.TireWearRL,
      packet.TireWearRR,
    ].some((value) => value !== 0)
  );
}
