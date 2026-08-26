import { expect, test } from "bun:test";
import { DEFAULT_TOGGLES } from "../src/lib/wireframe-data";
import { toSemanticFrame } from "../src/components/onboarding/steps/WelcomeStep";
import { buildLoadTrail } from "../src/components/wireframe/CarScene";

import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
function frame(index: number): SemanticAnalysisFrame {
  return {
    values: {
      "motion.position-x": index,
      "motion.position-z": 0,
      "motion.yaw": 0,
      "timing.current-lap": 1,
      "suspension.norm-suspension-travel": [0.5, 0.5, 0.5, 0.5],
    },
    states: {},
    freshness: {},
  };
}

test("bounds welcome load trail work for long telemetry recordings", () => {
  const telemetry = Array.from({ length: 14_000 }, (_, index) => frame(index));
  const trail = buildLoadTrail(telemetry, telemetry.length - 1, { min: 0, max: 100 }, 1, 1, 1);

  expect(trail.length).toBeLessThanOrEqual(64);
});

test("enables input lines in default wireframe view", () => {
  expect(DEFAULT_TOGGLES.inputs).toBe(true);
});

test("maps demo pedal and tire channels into semantic inputs", () => {
  const packet = {
    Accel: 200,
    Brake: 64,
    NormSuspensionTravelFL: 0.25,
    TireSlipRatioFL: 0.4,
    TireTempFL: 180,
  } as Parameters<typeof toSemanticFrame>[0];
  const values = toSemanticFrame(packet).values;

  expect(values["inputs.accel"]).toBe(200);
  expect(values["inputs.brake"]).toBe(64);
  expect(values["suspension.norm-suspension-travel"]).toEqual([0.25, undefined, undefined, undefined]);
  expect(values["tires.tire-slip-ratio"]).toEqual([0.4, undefined, undefined, undefined]);
  expect(values["tire.temperature.average"]).toEqual([180, undefined, undefined, undefined]);
});
