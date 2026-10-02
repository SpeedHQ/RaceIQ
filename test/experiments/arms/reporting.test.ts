import { describe, expect, test } from "bun:test";
import { compareArms, describeComparison, serializeComparison } from "../../../server/experiments/comparison/compare";
import { OUTCOME_METRICS } from "../../../server/experiments/comparison/metrics";
import { metadataArm, normals, telemetryArm } from "../../support/experiments/arms";

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
