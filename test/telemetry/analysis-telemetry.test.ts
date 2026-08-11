import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ANALYSIS_TELEMETRY,
  hasTireHealthData,
  hasTireTemperatureData,
  resolveAnalysisTelemetry,
} from "../../shared/racing/analysis/telemetry-capabilities";
import { initGameAdapters } from "../../shared/games/init";
import { getGame } from "../../shared/games/registry";
import { suspensionCompression } from "../../shared/racing/analysis/laps/physics/vehicle";
import type { TelemetryPacket } from "../../shared/telemetry/types";

initGameAdapters();

describe("analysis telemetry capabilities", () => {
  test("iRacing declares source limitations and snapshot freshness explicitly", () => {
    const analysis = resolveAnalysisTelemetry(getGame("iracing"));

    expect(analysis.gForce).toEqual({
      source: "derived",
      confidence: "exact",
      binding: {
        kind: "derived",
        derivation: "g-force-v1",
        requires: ["motion.acceleration-x", "motion.acceleration-z"],
      },
    });
    expect(analysis.slipRatio).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(analysis.wheelRotation).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(analysis.tireTemperature).toEqual({
      source: "direct",
      freshness: "pit-snapshot",
      display: "per-wheel",
      binding: { kind: "value", semanticId: "tire.temperature.average" },
    });
    expect(analysis.tirePressure).toEqual({
      source: "direct",
      freshness: "static",
      display: "cold-pressure",
      binding: { kind: "value", semanticId: "tires.tire-pressure" },
    });
    expect(analysis.suspensionTravel).toEqual({
      source: "direct",
      freshness: "continuous",
      display: "millimeters",
      binding: { kind: "value", semanticId: "suspension.suspension-travel-m" },
    });
  });

  test("requires iRacing pit snapshot availability instead of treating normalized zeros as data", () => {
    const analysis = resolveAnalysisTelemetry(getGame("iracing"));
    const beforeSnapshot = {
      TireCarcassTempFL: 0,
      TireCarcassTempFR: 0,
      TireCarcassTempRL: 0,
      TireCarcassTempRR: 0,
      TireWearFL: 0,
      TireWearFR: 0,
      TireWearRL: 0,
      TireWearRR: 0,
      iracing: {
        pitTireTemperatureAvailable: false,
        pitTireWearAvailable: false,
      },
    } as TelemetryPacket;

    expect(hasTireTemperatureData(beforeSnapshot, analysis.tireTemperature)).toBe(false);
    expect(hasTireHealthData(beforeSnapshot, analysis.tireHealth)).toBe(false);

    const newTireSnapshot = {
      ...beforeSnapshot,
      iracing: {
        pitTireTemperatureAvailable: true,
        pitTireWearAvailable: true,
      },
    } as TelemetryPacket;
    expect(hasTireTemperatureData(newTireSnapshot, analysis.tireTemperature)).toBe(true);
    expect(hasTireHealthData(newTireSnapshot, analysis.tireHealth)).toBe(true);
  });

  test("other adapters override only their real source differences", () => {
    expect(resolveAnalysisTelemetry(getGame("f1-2025")).surface).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(resolveAnalysisTelemetry(getGame("acc")).surface).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(resolveAnalysisTelemetry(getGame("ac-evo")).suspensionTravel).toEqual({
      source: "direct",
      freshness: "continuous",
      display: "millimeters",
      binding: { kind: "value", semanticId: "suspension.suspension-travel-m" },
    });
    const acEvo = resolveAnalysisTelemetry(getGame("ac-evo"));
    expect(acEvo.balance.source).toBe("derived");
    expect(acEvo.traction.source).toBe("derived");
    expect(acEvo.tireTemperature.source).toBe("direct");
    expect(resolveAnalysisTelemetry(getGame("fm-2023")).slipRatio).toEqual({
      source: "direct",
      freshness: "continuous",
      display: "per-wheel",
      binding: { kind: "value", semanticId: "tires.tire-slip-ratio" },
    });
  });

  test("advertises every catalog-backed Analyse Data metric", () => {
    const supported = {
      "fm-2023": ["balance", "gForce", "gripDemand", "traction", "tireTemperature", "surface", "slipRatio", "lateralSlip", "wheelRotation", "tireHealth", "tireWearRate", "suspensionTravel", "suspensionCompressionBias"],
      "f1-2025": ["balance", "gForce", "gripDemand", "traction", "tireTemperature", "slipRatio", "slipAngle", "wheelRotation", "tireHealth", "tireWearRate", "tirePressure", "suspensionTravel"],
      acc: ["balance", "gForce", "gripDemand", "traction", "tireTemperature", "slipRatio", "slipAngle", "wheelRotation", "tireHealth", "tireWearRate", "tirePressure", "suspensionTravel", "suspensionCompressionBias"],
      "ac-evo": ["balance", "gForce", "gripDemand", "traction", "tireTemperature", "slipRatio", "slipAngle", "wheelRotation", "tireHealth", "tireWearRate", "tirePressure", "suspensionTravel", "suspensionCompressionBias"],
      iracing: ["balance", "gForce", "tireTemperature", "surface", "tireHealth", "tirePressure", "suspensionTravel"],
    } as const;

    for (const [gameId, metrics] of Object.entries(supported)) {
      const analysis = resolveAnalysisTelemetry(getGame(gameId as keyof typeof supported));
      for (const metric of metrics) {
        expect(analysis[metric].source, `${gameId}.${metric}`).not.toBe("unavailable");
      }
    }
  });
});

describe("suspension compression distribution", () => {
  test("normalizes all four corners instead of presenting averages as load", () => {
    const packet = {
      NormSuspensionTravelFL: 0.39,
      NormSuspensionTravelFR: 0.59,
      NormSuspensionTravelRL: 0.18,
      NormSuspensionTravelRR: 0.46,
    } as TelemetryPacket;

    const compression = suspensionCompression(packet);

    expect(compression.frontBias).toBeCloseTo(0.98 / 1.62);
    expect(compression.leftBias).toBeCloseTo(0.57 / 1.62);
  });
});
