import { expect, test } from "bun:test";
import { DEFAULT_TOGGLES } from "../src/lib/wireframe-data";
import { buildDemoFixture } from "../../scripts/telemetry/generate-demo-fixture";
import { buildLoadTrail } from "../src/components/wireframe/CarScene";

import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
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

test("generates canonical pedal and tire channels for demo packets", () => {
  const packet = {
    Accel: 200,
    Brake: 64,
    Speed: 50,
    WheelRotationSpeedFL: 170,
    WheelRotationSpeedFR: 151.5151515,
    WheelRotationSpeedRL: 151.5151515,
    WheelRotationSpeedRR: 151.5151515,
    NormSuspensionTravelFL: 0.25,
    NormSuspensionTravelFR: 0.3,
    NormSuspensionTravelRL: 0.35,
    NormSuspensionTravelRR: 0.4,
    TireSlipRatioFL: 0.4,
    TireSlipRatioFR: 0.3,
    TireSlipRatioRL: 0.2,
    TireSlipRatioRR: 0.1,
    TireSlipAngleFL: 0.2,
    TireSlipAngleFR: 0.1,
    TireSlipAngleRL: 0.05,
    TireSlipAngleRR: 0.02,
    TireTempFL: 180,
    TireTempFR: 181,
    TireTempRL: 182,
    TireTempRR: 183,
  } as TelemetryPacket;
  const values = buildDemoFixture([packet])[0].values;

  expect(values["inputs.accel"]).toBe(200);
  expect(values["inputs.brake"]).toBe(64);
  expect(values["suspension.norm-suspension-travel"]).toEqual([0.25, 0.3, 0.35, 0.4]);
  expect(values["tires.tire-slip-ratio"]).toEqual([expect.closeTo(0.109, 2), 0, 0, 0]);
  expect(values["tires.normalized-tire-slip-angle"]).toEqual([0.2, 0.1, 0.05, 0.02]);
  expect(values["tire.temperature.average"]).toEqual([180, 181, 182, 183]);
});
