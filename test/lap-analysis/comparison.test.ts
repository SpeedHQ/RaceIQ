import { describe, expect, test } from "bun:test";
import { compareLaps } from "../../server/lap-analysis/comparison";
import { semanticSamplesFromReplay } from "../../server/telemetry/semantic-samples";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { SemanticTelemetryReplay } from "../../shared/telemetry/replay/contracts";

function sample(values: Partial<SemanticTelemetrySample["values"]> = {}, observedAtMs = 0, sequence = "0"): SemanticTelemetrySample {
  return {
    sequence,
    observedAtMs,
    values: {
      "motion.speed": 10,
      "inputs.accel": 128,
      "inputs.brake": 0,
      "inputs.steer": 127,
      "engine.current-engine-rpm": 4000,
      "tires.tire-wear": [0, 0, 0, 0],
      "fuel.fuel": 1,
      "timing.distance-traveled": 0,
      "motion.position-x": 0,
      "motion.position-z": 0,
      ...values,
    },
  };
}

function lineLap({ detour = false, shortcut = false, timeOffset = 0 } = {}): SemanticTelemetrySample[] {
  const points = shortcut ? Array.from({ length: 15 }, (_, index) => index * 5) : Array.from({ length: 21 }, (_, index) => index * 5);
  const out = points.map((x, index) =>
    sample(
      {
        "timing.distance-traveled": x,
        "motion.position-x": x,
        "motion.position-z": 0,
        "inputs.accel": x === 75 ? 200 : 128,
      },
      (x / 10) * 1000 + (x === 0 ? 0 : timeOffset),
      String(index),
    ),
  );
  if (detour) {
    const insertAt = out.findIndex((entry) => entry.values["motion.position-x"] === 50) + 1;
    out.splice(
      insertAt,
      0,
      sample({ "timing.distance-traveled": 70, "motion.position-x": 55, "motion.position-z": 20, "inputs.accel": 255 }, 9000, String(insertAt)),
      sample({ "timing.distance-traveled": 80, "motion.position-x": 50, "motion.position-z": 0, "inputs.accel": 255 }, 10000, String(insertAt + 1)),
      sample({ "timing.distance-traveled": 90, "motion.position-x": 60, "motion.position-z": 0, "inputs.accel": 255 }, 11000, String(insertAt + 2)),
    );
    for (let index = insertAt + 3; index < out.length; index++) {
      const distance = out[index].values["timing.distance-traveled"];
      out[index] = sample(
        {
          ...out[index].values,
          "timing.distance-traveled": typeof distance === "number" ? distance + 40 : distance,
        },
        out[index].observedAtMs + 4000,
        String(index),
      );
    }
  }
  return out;
}

describe("compare lap course alignment", () => {
  test("keeps crash lap inputs aligned to same on-track position", () => {
    const clean = lineLap();
    const crash = lineLap({ detour: true });
    const result = compareLaps(clean, crash, [], { lapAIsValid: true, lapBIsValid: true, trackLengthMeters: 100 });
    expect(result.distances.at(-1)).toBe(100);
    expect(result.lapA.sourceIndices).toHaveLength(result.distances.length);
    expect(result.lapB.sourceIndices).toHaveLength(result.distances.length);
    const position = crash[result.lapB.sourceIndices[75]].values["motion.position-x"];
    expect(typeof position === "number" && position).toBeGreaterThanOrEqual(70);
    expect(typeof position === "number" && position).toBeLessThanOrEqual(80);
    expect(result.timeDelta[75]).toBeLessThan(-3);
  });

  test("chooses clean reference when another lap takes shortcut", () => {
    const result = compareLaps(lineLap(), lineLap({ shortcut: true }), [], {
      lapAIsValid: true,
      lapBIsValid: true,
      trackLengthMeters: 100,
    });
    expect(result.distances.at(-1)).toBe(100);
  });

  test("keeps projected position monotonic through missing and noisy semantic values", () => {
    const noisy = lineLap();
    noisy.splice(4, 0, { sequence: "4a", observedAtMs: 3500, values: { "timing.distance-traveled": 35 } });
    noisy.splice(6, 0, sample({ "timing.distance-traveled": 200, "motion.position-x": 35, "motion.position-z": 0 }, 5500, "6a"));
    const result = compareLaps(lineLap(), noisy, [], { trackLengthMeters: 100 });
    const positions = result.lapB.sourceIndices.map((index) => noisy[index].values["motion.position-x"]).filter((position): position is number => typeof position === "number" && position > 0);
    for (let index = 1; index < positions.length; index++) expect(positions[index]).toBeGreaterThanOrEqual(positions[index - 1]);
  });

  test("uses semantic timing distance when world positions are unavailable", () => {
    const a = lineLap().map((entry, index) => sample({ ...entry.values, "motion.position-x": 0, "motion.position-z": 0, "timing.distance-traveled": index * 5 }, entry.observedAtMs, String(index)));
    const b = lineLap().map((entry, index) => sample({ ...entry.values, "motion.position-x": 0, "motion.position-z": 0, "timing.distance-traveled": index * 5 }, entry.observedAtMs, String(index)));
    const result = compareLaps(a, b, []);
    expect(result.distances.at(-1)).toBe(100);
    expect(result.lapA.throttle).toEqual(result.lapB.throttle);
  });

  test("preserves unavailable semantic values without packet fallback", () => {
    const lapA = lineLap().map((entry, index) => sample({ ...entry.values, "motion.position-x": 0, "motion.position-z": 0 }, entry.observedAtMs, String(index)));
    lapA[10] = {
      sequence: lapA[10].sequence,
      observedAtMs: lapA[10].observedAtMs,
      values: { "timing.distance-traveled": 50 },
    };
    const result = compareLaps(lapA, lineLap(), []);
    expect(Number.isNaN(result.lapA.speed[50])).toBe(true);
    expect(Number.isNaN(result.lapA.throttle[50])).toBe(true);
  });

  test("averages structured semantic tire wear", () => {
    const lap = lineLap().map((entry) =>
      sample(
        {
          ...entry.values,
          "tires.tire-wear": [0.1, 0.2, 0.3, 0.4],
        },
        entry.observedAtMs,
        entry.sequence,
      ),
    );
    const result = compareLaps(lap, lineLap(), []);
    expect(result.lapA.tireWear[0]).toBeCloseTo(0.25, 6);
  });

  test("excludes stale replay values from comparison samples", () => {
    const replay = {
      envelopes: [
        {
          sequence: 1n,
          observedAt: { domain: "session", milliseconds: 100 },
          values: [
            { semanticId: "motion.speed", state: "ok", freshness: "stale", value: 50 },
            { semanticId: "inputs.accel", state: "ok", freshness: "fresh", value: 128 },
          ],
        },
      ],
    } as unknown as SemanticTelemetryReplay;
    const [resolved] = semanticSamplesFromReplay(replay);
    expect(resolved.values["motion.speed"]).toBeUndefined();
    expect(resolved.values["inputs.accel"]).toBe(128);
  });

  test("preserves clean lap grid and elapsed delta", () => {
    const result = compareLaps(lineLap(), lineLap({ timeOffset: 500 }), []);
    expect(result.distances).toHaveLength(101);
    expect(result.timeDelta.at(-1)).toBeCloseTo(-0.5, 3);
  });

  test("carries exact aligned and source bounds for corners with different spans", () => {
    const lapA = lineLap().map((entry, index) => sample({ ...entry.values, "motion.position-x": 0, "motion.position-z": 0 }, entry.observedAtMs, String(index)));
    const lapB = lineLap({ timeOffset: 500 }).map((entry, index) => sample({ ...entry.values, "motion.position-x": 0, "motion.position-z": 0 }, entry.observedAtMs, String(index)));
    const result = compareLaps(lapA, lapB, [
      { index: 0, label: "T1", distanceStart: 10, distanceEnd: 20 },
      { index: 1, label: "T2", distanceStart: 40, distanceEnd: 70 },
    ]);

    expect(result.cornerDeltas).toEqual([
      expect.objectContaining({
        label: "T1",
        distanceStart: 10,
        distanceEnd: 20,
        alignedStartIndex: 10,
        alignedEndIndex: 20,
        sourceStartIndexA: 2,
        sourceEndIndexA: 4,
        sourceStartIndexB: 2,
        sourceEndIndexB: 4,
      }),
      expect.objectContaining({
        label: "T2",
        distanceStart: 40,
        distanceEnd: 70,
        alignedStartIndex: 40,
        alignedEndIndex: 70,
        sourceStartIndexB: 8,
        sourceEndIndexB: 14,
      }),
    ]);
  });
});
