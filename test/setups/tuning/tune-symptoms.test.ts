import { describe, expect, test } from "bun:test";
import type { Corner } from "../../../server/lap-analysis/corners";
import { telemetryToSymptoms } from "../../../server/ai/tune-symptoms";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";

function sample(distance: number, values: SemanticTelemetrySample["values"] = {}): SemanticTelemetrySample {
  return {
    sequence: String(distance),
    observedAtMs: distance,
    values: {
      "timing.distance-traveled": distance,
      "motion.speed": 100,
      "inputs.brake": 0,
      "tires.tire-slip-ratio": [0, 0, 0, 0],
      "tires.tire-slip-angle": [0, 0, 0, 0],
      "suspension.norm-suspension-travel": [0, 0, 0, 0],
      ...values,
    },
  };
}

describe("telemetryToSymptoms — semantic relative corner distance", () => {
  test("matches frames and places corners when the lap doesn't start at 0", () => {
    const start = 1000;
    const samples: SemanticTelemetrySample[] = [];
    for (let relative = 0; relative <= 300; relative += 5) {
      const cornering = relative >= 100 && relative <= 200;
      samples.push(
        sample(start + relative, {
          "tires.tire-slip-angle": [cornering ? 0.12 : 0, cornering ? 0.12 : 0, 0, 0],
        }),
      );
    }
    const corners: Corner[] = [{ index: 1, label: "T1", distanceStart: 100, distanceEnd: 200 }];
    const symptoms = telemetryToSymptoms("acc", samples, corners);
    expect(symptoms.corners).toHaveLength(1);
    expect(symptoms.aggregate.understeerCorners).toContain("T1");
    expect(symptoms.corners[0].distanceFrac).toBeCloseTo(0.5, 2);
  });

  test("suppresses only channels with invalid wheel cardinality", () => {
    const samples = Array.from({ length: 61 }, (_, index) => sample(500 + index * 5, { "tires.tire-slip-angle": [0.2, 0.2, 0] }));
    const corners: Corner[] = [{ index: 1, label: "T1", distanceStart: 100, distanceEnd: 200 }];
    const symptoms = telemetryToSymptoms("acc", samples, corners);
    expect(symptoms.corners).toHaveLength(1);
    expect(symptoms.corners[0].phases.every((phase) => phase.balance === undefined)).toBe(true);
    expect(symptoms.aggregate.damper).toBeNull();
  });
});
