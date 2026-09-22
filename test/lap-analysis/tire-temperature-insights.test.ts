import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@shared/games/init";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import { detectTireOverheat, detectTireSurfaceProfile, detectTireTempSplit } from "@shared/racing/analysis/laps/insights/tires";
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
    const samples = repeated(120, {
      TireCarcassTempFL: 125,
      TireCarcassTempFR: 125,
      TireCarcassTempRL: 90,
      TireCarcassTempRR: 90,
    });
    expect(analyzeLap(samples, "f1-2025").find((insight) => insight.id === "tire-temp-split")?.severity).toBe("warning");
    for (const sample of samples) sample.TireCarcassTempFL = sample.TireCarcassTempFR = 90;
    expect(analyzeLap(samples, "f1-2025").some((insight) => insight.id === "tire-temp-split")).toBe(false);
  });

  test("does not treat iRacing pit snapshots as sustained lap temperature", () => {
    const insights = analyzeLap(repeated(120, { TireTempFL: 130, TireTempFR: 130, TireTempRL: 90, TireTempRR: 90 }), "iracing");

    expect(insights.some((insight) => insight.id.startsWith("tire-overheat-") || insight.id === "tire-temp-split")).toBe(false);
  });

  test("requires separated operating windows before reporting tread gradients", () => {
    const profile = {
      TireSurfaceTempInnerFL: 112,
      TireSurfaceTempMiddleFL: 100,
      TireSurfaceTempOuterFL: 90,
      TireSurfaceTempInnerFR: 90,
      TireSurfaceTempMiddleFR: 110,
      TireSurfaceTempOuterFR: 90,
    };
    expect(detectTireSurfaceProfile(repeated(120, profile), "celsius")).toEqual([]);
    const insights = analyzeLap(repeated(1125, profile), "ac-evo").filter((insight) => insight.id.startsWith("tire-surface-"));
    expect(insights.map((insight) => [insight.id, insight.severity])).toEqual([
      ["tire-surface-edge-imbalance-FL", "info"],
      ["tire-surface-pressure-shape-FR", "info"],
    ]);
    expect(insights.every((insight) => insight.frameIndices.length >= 3)).toBe(true);
  });
});

function timed(seconds: number, hz: number, values: (time: number) => Partial<TelemetryPacket>): TelemetryPacket[] {
  return Array.from({ length: Math.round(seconds * hz) }, (_, i) => packet({ TimestampMS: i * 1000 / hz, ...values(i / hz) }));
}

function fahrenheit(samples: TelemetryPacket[]): TelemetryPacket[] {
  return samples.map((sample) => {
    const converted = { ...sample };
    for (const key of Object.keys(converted)) {
      if (key.startsWith("TireTemp") || key.startsWith("TireCarcassTemp") || key.startsWith("TireSurfaceTemp")) {
        const field = key as keyof TelemetryPacket;
        const value = sample[field];
        if (typeof value === "number") Object.assign(converted, { [field]: value * 1.8 + 32 });
      }
    }
    return converted;
  });
}

describe("unit-independent tire evidence", () => {
  test("applies equivalent absolute warning and critical temperatures", () => {
    for (const [temperature, severity] of [[109, undefined], [115, "warning"], [135, "critical"]] as const) {
      const samples = timed(2, 60, () => ({ TireTempFL: temperature }));
      expect(detectTireOverheat(samples, "celsius").find((insight) => insight.id === "tire-overheat-FL")?.severity).toBe(severity);
      expect(detectTireOverheat(fahrenheit(samples), "fahrenheit").find((insight) => insight.id === "tire-overheat-FL")?.severity).toBe(severity);
    }
  });

  test("applies equivalent temperature differences", () => {
    for (const delta of [11, 13, 23]) {
      const samples = timed(3, 60, () => ({ TireTempFL: 90 + delta, TireTempFR: 90 + delta }));
      const expected = delta === 11 ? undefined : delta === 13 ? "info" : "warning";
      expect(detectTireTempSplit(samples, "celsius")?.severity).toBe(expected);
      expect(detectTireTempSplit(fahrenheit(samples), "fahrenheit")?.severity).toBe(expected);
    }
  });

  test("a critical temperature flash does not promote a sustained warning", () => {
    const samples = timed(3, 60, (time) => ({ TireTempFL: time >= 1 && time < 1.05 ? 150 : 115 }));
    expect(detectTireOverheat(samples, "celsius").find((insight) => insight.id === "tire-overheat-FL")?.severity).toBe("warning");
  });

  test("does not combine short observations across timestamp discontinuities", () => {
    const samples = [
      ...timed(0.1, 60, () => ({ TireTempFL: 120 })),
      ...timed(0.1, 60, () => ({ TireTempFL: 120 })).map((sample) => ({ ...sample, TimestampMS: sample.TimestampMS + 2000 })),
    ];
    expect(detectTireOverheat(samples, "celsius")).toEqual([]);
  });

  test("time-weights axle balance instead of weighting packet density", () => {
    const samples = [
      ...timed(2, 120, () => ({ TireTempFL: 110, TireTempFR: 110 })),
      ...timed(2, 20, () => ({ TireTempRL: 110, TireTempRR: 110 })).map((sample) => ({ ...sample, TimestampMS: sample.TimestampMS + 2000 })),
    ];
    expect(detectTireTempSplit(samples, "celsius")).toBeNull();
  });
});

describe("persistent tread observations", () => {
  test("retains equivalent gradients across units and sampling rates", () => {
    for (const hz of [20, 60, 120]) {
      const samples = timed(18, hz, () => ({
        TireSurfaceTempInnerFL: 112, TireSurfaceTempMiddleFL: 100, TireSurfaceTempOuterFL: 90,
      }));
      for (const [input, unit] of [[samples, "celsius"], [fahrenheit(samples), "fahrenheit"]] as const) {
        const insights = detectTireSurfaceProfile(input, unit);
        expect(insights.map((insight) => [insight.id, insight.severity])).toEqual([["tire-surface-edge-imbalance-FL", "info"]]);
        expect(insights[0].frameIndices.map((index) => Math.round(input[index].TimestampMS / 1000))).toEqual([4, 7, 10, 13, 16]);
      }
    }
  });

  test("rejects short flashes, early-only gradients, and changing warmup temperatures", () => {
    const cases = [
      (time: number) => ({ inner: time >= 8 && time < 8.2 ? 300 : 90, middle: 90, outer: 90 }),
      (time: number) => ({ inner: time < 10 ? 112 : 90, middle: 90, outer: 90 }),
      (time: number) => ({ inner: 50 + time * 3 + 22, middle: 50 + time * 3 + 10, outer: 50 + time * 3 }),
    ];
    for (const values of cases) {
      const samples = timed(30, 60, (time) => {
        const profile = values(time);
        return { TireSurfaceTempInnerFL: profile.inner, TireSurfaceTempMiddleFL: profile.middle, TireSurfaceTempOuterFL: profile.outer };
      });
      expect(detectTireSurfaceProfile(samples, "celsius")).toEqual([]);
    }
  });

  test("missing bands and invalid timing cannot establish a persistent profile", () => {
    for (const value of [undefined, NaN, 0]) {
      const samples = timed(18, 60, () => ({ TireSurfaceTempInnerFL: 112, TireSurfaceTempMiddleFL: value, TireSurfaceTempOuterFL: 90 }));
      expect(detectTireSurfaceProfile(samples, "celsius")).toEqual([]);
    }
    const paused = repeated(1125, { TimestampMS: 0, TireSurfaceTempInnerFL: 112, TireSurfaceTempMiddleFL: 100, TireSurfaceTempOuterFL: 90 });
    expect(detectTireSurfaceProfile(paused, "celsius")).toEqual([]);
  });
});
