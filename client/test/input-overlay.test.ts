import { expect, test } from "bun:test";
import { buildInputOverlayRuns } from "../src/components/wireframe/InputOverlay";
import { buildTrackIndex } from "../src/lib/wireframe-utils";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";

function frame(x: number, z: number, throttle = 0, brake = 0): SemanticAnalysisFrame {
  return { values: { "motion.position-x": x, "motion.position-z": z, "inputs.accel": throttle, "inputs.brake": brake } } as SemanticAnalysisFrame;
}

function build(telemetry: SemanticAnalysisFrame[], yaw = 0): SemanticAnalysisFrame {
  return { values: { "motion.position-x": 0, "motion.position-z": 0, "motion.yaw": yaw } } as SemanticAnalysisFrame;
}

test("indexes nearby input runs and preserves source ids and intensities", () => {
  const telemetry = [
    frame(0, 0, 0.4, 128),
    frame(0, 1, 0.5, 255),
    frame(0, 2, 0.6, 64),
    frame(0, 3, 0.7, 32),
    frame(0, 4, 0.8, 64),
    frame(0, 5, 0.9, 32),
    frame(0, 100, 1, 255),
  ];
  const result = buildInputOverlayRuns(telemetry, buildTrackIndex(telemetry.map((p) => ({ x: p.values["motion.position-x"] as number, z: p.values["motion.position-z"] as number }))), build(telemetry));

  expect(result.throttleRuns).toHaveLength(1);
  expect(result.throttleRuns[0]).toMatchObject({ id: 0, values: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9] });
  expect(result.brakeRuns[0]).toMatchObject({ id: 0, values: [128 / 255, 1, 64 / 255, 32 / 255, 64 / 255, 32 / 255] });
  expect(result.throttleRuns[0]?.pts[0]).toEqual([0, -0.44, 0.1]);
});

test("applies yaw transform and source index identity", () => {
  const telemetry = [frame(0, 0), frame(0, 1), frame(1, 0, 0.3), frame(2, 0, 0.3), frame(3, 0, 0.3), frame(4, 0, 0.3), frame(5, 0, 0.3)];
  const points = telemetry.map((p) => ({ x: p.values["motion.position-x"] as number, z: p.values["motion.position-z"] as number }));
  const result = buildInputOverlayRuns(telemetry, buildTrackIndex(points), build(telemetry, Math.PI / 2));

  expect(result.throttleRuns).toHaveLength(1);
  expect(result.throttleRuns[0]?.id).toBe(2);
  expect(result.throttleRuns[0]?.pts[0]?.[0]).toBeCloseTo(0.9553);
  expect(result.throttleRuns[0]?.pts[0]?.[2]).toBeCloseTo(0.0894);
});
test("splits pedal-off gaps and drops runs shorter than five points", () => {
  const telemetry = [
    frame(0, 0, 0.3), frame(0, 1, 0.3), frame(0, 2, 0), frame(0, 3, 0.3), frame(0, 4, 0.3),
    frame(0, 5, 0.3), frame(0, 6, 0.3), frame(0, 7, 0.3), frame(0, 8, 0.3),
  ];
  const points = telemetry.map((p) => ({ x: p.values["motion.position-x"] as number, z: p.values["motion.position-z"] as number }));
  const result = buildInputOverlayRuns(telemetry, buildTrackIndex(points), build(telemetry));

  expect(result.throttleRuns).toHaveLength(1);
  expect(result.throttleRuns[0]?.id).toBe(3);
  expect(result.throttleRuns[0]?.values).toHaveLength(6);
});
