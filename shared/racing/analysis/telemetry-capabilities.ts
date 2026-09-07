import type { TelemetryPacket } from "../../telemetry/types";
import type {
  AnalysisTelemetryMetric,
  AnalysisTelemetryModel,
  GameAdapter,
} from "../../games/types";

export const DEFAULT_ANALYSIS_TELEMETRY: AnalysisTelemetryModel = {
  balance: { source: "unavailable", reason: "missing-model" },
  brakeBias: { source: "unavailable", reason: "source-limitation" },
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

export function hasTireHealthDataSemantic(
  wear: readonly number[] | undefined,
  metric: AnalysisTelemetryMetric,
): boolean {
  if (metric.source !== "direct" || metric.freshness !== "pit-snapshot") return metric.source !== "unavailable";
  return (wear ?? []).some((value) => value !== 0);
}
