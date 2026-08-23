import { describe, expect, test } from "bun:test";
import type { ComparisonData, SemanticTelemetrySample } from "../../shared/racing/comparison/types";
import { buildComparisonChartData } from "../src/components/comparison/ComparisonCharts";
import { drawComparisonWorldOverlay, drawMultiComparisonWorldOverlay, resolveAlignedCursor } from "../src/lib/comparison-utils";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const packet = (position: number): TelemetryPacket => ({ PositionX: position, PositionZ: 0 }) as TelemetryPacket;

describe("comparison aligned cursor", () => {
  test("resolves each lap through its aligned source index", () => {
    const telemetryA = [0, 50, 75, 100].map(packet);
    const telemetryB = [0, 50, 55, 75, 100].map(packet);
    const cursor = resolveAlignedCursor(telemetryA, telemetryB, [0, 50, 75, 100], [0, 1, 2, 3], [0, 1, 3, 4], 75);
    expect(cursor).toEqual({ gridIndex: 2, packetA: telemetryA[2], packetB: telemetryB[3] });
  });

  test("returns null for empty cursor and does not substitute invalid indices", () => {
    expect(resolveAlignedCursor([], [], [], [], [], null)).toBeNull();
    const cursor = resolveAlignedCursor([packet(0)], [packet(0)], [0], [4], [0], 0);
    expect(cursor?.packetA).toBeNull();
    expect(cursor?.packetB).not.toBeNull();
  });
});
test("comparison line layer can be hidden independently", () => {
  let strokes = 0;
  const context = {
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    strokeStyle: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      strokes++;
    },
  } as unknown as CanvasRenderingContext2D;
  const telemetry = [
    { values: { "motion.position-x": 1, "motion.position-z": 1 }, sequence: "1", observedAtMs: 1 },
    { values: { "motion.position-x": 2, "motion.position-z": 2 }, sequence: "2", observedAtMs: 2 },
  ] satisfies SemanticTelemetrySample[];
  const options = {
    context,
    width: 100,
    height: 100,
    toCanvas: (x: number, z: number): [number, number] => [x, z],
    outline: [],
    telemetryA: telemetry,
    telemetryB: telemetry,
    hoveredDistance: null,
    zoomed: false,
  };

  drawComparisonWorldOverlay({ ...options, showRacingLines: false });
  expect(strokes).toBe(0);
  drawComparisonWorldOverlay({ ...options, showRacingLines: true });
  expect(strokes).toBe(2);
  drawMultiComparisonWorldOverlay({
    ...options,
    series: [
      { telemetry, color: "orange" },
      { telemetry, color: "blue" },
      { telemetry, color: "green" },
    ],
    showRacingLines: true,
  });
  expect(strokes).toBe(5);
});

test("comparison charts render reference plus every selected lap on one distance grid", () => {
  const comparison = {
    traces: {
      distance: [0, 100],
      sourceIndicesA: [0, 1],
      sourceIndicesB: [0, 1],
      speedA: [100, 120],
      speedB: [90, 110],
      throttleA: [0.5, 1],
      throttleB: [0.4, 0.9],
      brakeA: [0, 0.2],
      brakeB: [0.1, 0],
      rpmA: [5_000, 6_000],
      rpmB: [4_800, 5_800],
    },
    timeDelta: [0, 1.25],
    telemetryA: [{ values: { "timing.current-lap": 7 } }, { values: { "timing.current-lap": 7 } }],
    telemetryB: [{ values: { "timing.current-lap": 7 } }, { values: { "timing.current-lap": 7 } }],
  } as unknown as ComparisonData;
  const shorterGridComparison = {
    ...comparison,
    traces: {
      ...comparison.traces,
      distance: [0, 50, 100],
      speedB: [80, 90, 100],
      throttleB: [0.2, 0.4, 0.6],
      brakeB: [0.3, 0.2, 0.1],
      rpmB: [4_000, 4_500, 5_000],
    },
    timeDelta: [0, 0.5, 1],
  } as ComparisonData;

  const data = buildComparisonChartData(
    { label: "A", color: "orange" },
    [
      { comparison, label: "B", color: "blue" },
      { comparison: shorterGridComparison, label: "C", color: "green" },
    ],
    { fromMph: (value) => value * 2, speedLabel: "test" },
  );

  expect(data.distance).toEqual([0, 100]);
  expect(data.series.map((series) => series.label)).toEqual(["A", "B", "C"]);
  expect(data.series[0]?.speed).toEqual([200, 240]);
  expect(data.series[2]?.speed).toEqual([160, 200]);
  expect(data.series[2]?.timeDelta).toEqual([0, 1]);
});
