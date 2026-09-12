/// <reference types="bun" />
import { expect, test } from "bun:test";
import { buildChartData } from "../../client/src/components/analyse/AnalyseChartsPanel";
import type { SemanticAnalysisFrame } from "../../client/src/components/analyse/track-map/types";

function frame(currentLap: number): SemanticAnalysisFrame {
  return {
    values: { "timing.current-lap": currentLap },
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
