import { describe, expect, test } from "bun:test";
import { compareArms, describeComparison, serializeComparison } from "@raceiq/analysis-core/racing/experiments/compare";
import { OUTCOME_METRICS } from "@raceiq/analysis-core/racing/experiments/metrics";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { ArmInput } from "@raceiq/analysis-core/racing/experiments/compare";
import type { ArmLap } from "@raceiq/analysis-core/racing/experiments/metrics";

let nextId = 1;
function metadataArm(times: number[]): ArmInput {
  return { laps: times.map((lapTime) => ({ lap: { id: nextId++, lapTime, isValid: true, invalidReason: null, experimentExcluded: false, experimentExcludedSource: null }, telemetry: null })) };
}
function normals(n: number, mean: number, sd: number, seed: number): number[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const values: number[] = [];
  while (values.length < n) {
    const u1 = Math.max(1e-12, random());
    const u2 = random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    values.push(mean + sd * radius * Math.cos(2 * Math.PI * u2));
    if (values.length < n) values.push(mean + sd * radius * Math.sin(2 * Math.PI * u2));
  }
  return values;
}
const corners = [{ index: 1, label: "T1", distanceStart: 200, distanceEnd: 300 }];
function telemetryArm(specs: { lateral: number; brakeShift: number }[]): ArmInput {
  const laps: ArmLap[] = specs.map(({ lateral, brakeShift }, index) => {
    const step = 600 / 120;
    const telemetry: TelemetryPacket[] = Array.from({ length: 121 }, (_, i) => {
      const distance = i * step;
      const inCorner = distance >= 200 && distance <= 300;
      const braking = distance >= 220 - brakeShift && distance <= 260 - brakeShift;
      return { gameId: "f1-2025", IsRaceOn: 1, TimestampMS: i * 100, DistanceTraveled: distance, PositionX: inCorner ? lateral : 0, PositionZ: distance, VelocityX: 0, VelocityY: 0, VelocityZ: step / 0.1, Gear: 3, Accel: braking ? 0 : 1, Brake: braking ? 1 : 0 } as TelemetryPacket;
    });
    return { lap: { id: nextId++, lapTime: 90 + index * 0.05, isValid: true, invalidReason: null, experimentExcluded: false, experimentExcludedSource: null }, telemetry };
  });
  return { label: "telemetry-arm", laps, corners };
}

// ── frame-based metrics ─────────────────────────────────────────────────────


describe("frame-based metrics via computeLapConsistencyDelta", () => {
  const scattered = [
    { lateral: 0, brakeShift: 0 },
    { lateral: 3, brakeShift: 20 },
    { lateral: -3, brakeShift: -20 },
    { lateral: 2.5, brakeShift: 15 },
    { lateral: -2.5, brakeShift: -15 },
    { lateral: 1.5, brakeShift: 10 },
  ];
  const repeatable = Array.from({ length: 6 }, () => ({ lateral: 0, brakeShift: 0 }));

  test("brake input variance separates a scattered arm from a repeatable one", () => {
    const cmp = compareArms(telemetryArm(scattered), telemetryArm(repeatable), OUTCOME_METRICS.inputVarianceBrake);

    // The arm's median-lap-time lap is the reference and is not its own sample.
    expect(cmp.a.n).toBe(scattered.length - 1);
    expect(cmp.significance).toBe("significant");
    expect(cmp.favours).toBe("b");
    expect(cmp.a.mean!).toBeGreaterThan(cmp.b.mean!);
    expect(cmp.b.mean!).toBe(0);
  });

  test("line consistency is higher-better and points at the repeatable arm", () => {
    const cmp = compareArms(telemetryArm(scattered), telemetryArm(repeatable), OUTCOME_METRICS.lineSpreadScore);

    expect(cmp.direction).toBe("higher-better");
    expect(cmp.significance).toBe("significant");
    expect(cmp.favours).toBe("b");
    expect(cmp.deltaMean!).toBeGreaterThan(0);
    expect(cmp.b.mean!).toBe(100);
  });

  test("three telemetry laps is one sample short of the guardrail", () => {
    const cmp = compareArms(
      telemetryArm(scattered.slice(0, 3)),
      telemetryArm(repeatable.slice(0, 3)),
      OUTCOME_METRICS.inputVarianceBrake,
    );
    expect(cmp.a.n).toBe(2);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.reason).toContain("measured laps");
  });
});

// ── reporting is a measurement, never a verdict ─────────────────────────────

describe("reporting", () => {
  test("describeComparison never claims the change was good", () => {
    const cmp = compareArms(
      metadataArm(normals(10, 90.0, 0.12, 101)),
      metadataArm(normals(10, 89.6, 0.12, 202)),
      OUTCOME_METRICS.lapTimeSec,
    );
    const text = describeComparison(cmp);
    expect(text).toContain("Distinguishable from noise");
    expect(text).toContain("driver's call");
    expect(text.toLowerCase()).not.toContain("better setup");
  });

  test("the comparison exposes no field named verdict", () => {
    const cmp = compareArms(metadataArm([90, 90.1, 90.2]), metadataArm([90, 90.1, 90.2]), OUTCOME_METRICS.lapTimeSec);
    expect(Object.keys(cmp)).not.toContain("verdict");
    expect(Object.keys(cmp)).toContain("significance");
  });

  test("serializeComparison is JSON-safe and keeps per-lap curation reasons", () => {
    const cmp = compareArms(
      metadataArm([90.0, 90.1, 90.2, 90.3, 90.4, 90.5]),
      metadataArm([90.0, 90.1, 90.2, 90.3, 90.4, 90.5]),
      OUTCOME_METRICS.lapTimeSec,
    );
    const json = JSON.parse(JSON.stringify(serializeComparison(cmp)));
    expect(json.a.lapReasons.length).toBe(6);
    // All six are `chosen` now — `lapTimeSec` no longer ranks any lap away.
    expect(json.a.lapReasons.filter((r: { reason: string }) => r.reason === "chosen").length).toBe(6);
    expect(json.summary).toContain("Lap time");
  });
});
