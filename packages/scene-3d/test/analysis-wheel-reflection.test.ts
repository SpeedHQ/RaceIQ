import { expect, test } from "bun:test";
import { analysisWheelTelemetryIndex } from "../src/wireframe/AnalysisWheels";

test("reflected scene maps physical wheel positions to opposite telemetry sides", () => {
  expect([0, 1, 2, 3].map((index) => analysisWheelTelemetryIndex(index, true))).toEqual([1, 0, 3, 2]);
});

test("unreflected scene keeps native wheel order", () => {
  expect([0, 1, 2, 3].map((index) => analysisWheelTelemetryIndex(index, false))).toEqual([0, 1, 2, 3]);
});
