/// <reference types="bun" />
import { expect, test } from "bun:test";
import { buildChartData } from "../../client/src/components/analyse/chart-data";
import type { SemanticAnalysisFrame } from "../../client/src/components/analyse/track-map/types";

function frame(currentLap: number, values: Record<string, unknown> = {}): SemanticAnalysisFrame {
  return {
    values: { "timing.current-lap": currentLap, ...values },
    states: {},
    freshness: {},
  };
}

test("chart x positions never run backward when final boundary frames reset lap timer", () => {
  const chart = buildChartData([
    frame(0),
    frame(50),
    frame(0.01),
    frame(100),
  ]);

  expect(chart?.timeFracs).toEqual([0, 0.5, 0.5, 1]);
});

test("chart temperature converter applies to tire core and brake series", () => {
  const chart = buildChartData([
    frame(0, {
      "tire.temperature.surface.representative": [100, 100, 100, 100],
      "tire.temperature.core": [90, 90, 90, 90],
      "brakes.brake-temp": [100, 100, 100, 100],
    }),
    frame(1, {
      "tire.temperature.surface.representative": [100, 100, 100, 100],
      "tire.temperature.core": [90, 90, 90, 90],
      "brakes.brake-temp": [100, 100, 100, 100],
    }),
  ], undefined, (celsius) => celsius * 2);

  expect(chart?.tireTempFL).toEqual([200, 200]);
  expect(chart?.tireCoreTempFL).toEqual([180, 180]);
  expect(chart?.brakeTempFL).toEqual([200, 200]);
});
