import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@shared/games/init";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import type { TelemetryPacket } from "@shared/telemetry/types";

initGameAdapters();

function packet(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    TimestampMS: 0,
    Speed: 40,
    Accel: 0,
    Brake: 0,
    Steer: 0,
    CurrentEngineRpm: 2_000,
    EngineMaxRpm: 8_000,
    WheelRotationSpeedFL: 120,
    WheelRotationSpeedFR: 120,
    WheelRotationSpeedRL: 120,
    WheelRotationSpeedRR: 120,
    TireTempFL: 90,
    TireTempFR: 90,
    TireTempRL: 90,
    TireTempRR: 90,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    NormSuspensionTravelFL: 0.5,
    NormSuspensionTravelFR: 0.5,
    NormSuspensionTravelRL: 0.5,
    NormSuspensionTravelRR: 0.5,
    Fuel: 10,
    Boost: 0,
    Power: 0,
    ...overrides,
  } as TelemetryPacket;
}

function repeated(count: number, overrides: Partial<TelemetryPacket>): TelemetryPacket[] {
  return Array.from({ length: count }, (_, index) => packet({ TimestampMS: index * 16, ...overrides }));
}

describe("static tire temperature layers", () => {
  test("detects separate core overheating without mislabeling the surface", () => {
    const insights = analyzeLap(
      repeated(20, {
        TireCarcassTempFL: 120,
        TireCarcassTempFR: 90,
        TireCarcassTempRL: 90,
        TireCarcassTempRR: 90,
      }),
      "f1-2025",
    );

    expect(insights.some((insight) => insight.id === "tire-core-overheat-FL")).toBe(true);
    expect(insights.some((insight) => insight.id === "tire-overheat-FL")).toBe(false);
  });

  test("does not duplicate ACC core aliases as a second temperature layer", () => {
    const insights = analyzeLap(
      repeated(20, {
        TireTempFL: 120,
        TireCarcassTempFL: 120,
        TireCarcassTempFR: 90,
        TireCarcassTempRL: 90,
        TireCarcassTempRR: 90,
      }),
      "acc",
    );

    expect(insights.some((insight) => insight.id === "tire-overheat-FL")).toBe(true);
    expect(insights.some((insight) => insight.id === "tire-core-overheat-FL")).toBe(false);
  });

  test("uses core temperatures for persistent front-rear balance", () => {
    const insight = analyzeLap(
      repeated(120, {
        TireCarcassTempFL: 125,
        TireCarcassTempFR: 125,
        TireCarcassTempRL: 90,
        TireCarcassTempRR: 90,
      }),
      "f1-2025",
    ).find((candidate) => candidate.id === "tire-temp-split");

    expect(insight?.detail).toContain("front axle 35°C hotter");
  });

  test("does not treat iRacing pit snapshots as sustained lap temperature", () => {
    const insights = analyzeLap(repeated(120, { TireTempFL: 130, TireTempFR: 130, TireTempRL: 90, TireTempRR: 90 }), "iracing");

    expect(insights.some((insight) => insight.id.startsWith("tire-overheat-") || insight.id === "tire-temp-split")).toBe(false);
  });

  test("diagnoses continuous inner-middle-outer surface profiles", () => {
    const insights = analyzeLap(
      repeated(120, {
        TireSurfaceTempInnerFL: 112,
        TireSurfaceTempMiddleFL: 100,
        TireSurfaceTempOuterFL: 90,
        TireSurfaceTempInnerFR: 90,
        TireSurfaceTempMiddleFR: 110,
        TireSurfaceTempOuterFR: 90,
      }),
      "ac-evo",
    );
    expect(insights.find((insight) => insight.id === "tire-surface-edge-imbalance-FL")?.detail).toContain("inner edge averaged 22.0°C hotter");
    expect(insights.find((insight) => insight.id === "tire-surface-pressure-shape-FR")?.detail).toContain("center averaged 20.0°C hotter");
  });
});
