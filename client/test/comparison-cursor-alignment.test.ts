import { describe, expect, test } from "bun:test";
import type { ComparisonData } from "../../shared/racing/comparison/types";
import { buildComparisonChartData } from "../src/components/comparison/ComparisonCharts";
import { resolveAlignedCursor } from "../src/lib/comparison-utils";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const packet = (position: number): TelemetryPacket => ({ PositionX: position, PositionZ: 0 } as TelemetryPacket);

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

test("comparison charts use server-aligned traces and elapsed time delta", () => {
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

  const data = buildComparisonChartData(comparison, { fromMph: (value) => value * 2, speedLabel: "test" });

  expect(data.distance).toEqual([0, 100]);
  expect(data.speedA).toEqual([200, 240]);
  expect(data.timeDelta).toEqual([0, 1.25]);
});
