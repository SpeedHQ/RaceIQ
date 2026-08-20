import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SemanticTelemetrySample } from "../../shared/racing/comparison/types";
import type { SemanticAnalysisFrame, TrackMapProps } from "../src/components/track-map/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const renderedMaps: TrackMapProps[] = [];
mock.module("@/components/track-map/TrackMapCanvas", () => ({
  TrackMapCanvas: (props: TrackMapProps) => {
    renderedMaps.push(props);
    return null;
  },
}));

// Import after TrackMapCanvas mock so server render exposes child props.
const { CompareTrackMap } = await import("../src/components/comparison/CompareTrackMap");

const sample = (x: number, z: number, index: number): SemanticTelemetrySample => ({
  values: {
    "motion.position-x": x,
    "motion.position-z": z,
    "timing.distance-traveled": index,
  },
  sequence: String(index),
  observedAtMs: index,
});

describe("CompareTrackMap alignment", () => {
  beforeEach(() => renderedMaps.splice(0));

  test("uses bounded telemetry geometry without transforming comparison laps", () => {
    const pointCount = 4_001;
    const outline = Array.from({ length: pointCount }, (_, index) => {
      const angle = (index / pointCount) * Math.PI * 2;
      return { x: Math.cos(angle) * 20, z: Math.sin(angle) * 10 };
    });
    const telemetry = outline.map((point, index) => sample(point.x + 500, point.z + 300, index));

    renderToStaticMarkup(
      createElement(CompareTrackMap, {
        outline,
        telemetryA: telemetry,
        telemetryB: telemetry,
        distanceGrid: [],
        sourceIndicesA: [],
        sourceIndicesB: [],
        labelA: "A",
        labelB: "B",
        lapTimeA: "1:00.000",
        lapTimeB: "1:00.000",
        segments: [],
        hoveredDistanceRef: { current: null },
        redrawRef: { current: null },
      }),
    );

    expect(renderedMaps).toHaveLength(2);
    for (const map of renderedMaps) {
      const mapTelemetry = map.telemetry as SemanticAnalysisFrame[];
      expect(mapTelemetry[0]!.values["motion.position-x"]).toBe(telemetry[0]!.values["motion.position-x"]);
      expect(mapTelemetry[0]!.values["motion.position-z"]).toBe(telemetry[0]!.values["motion.position-z"]);
      expect(map.outline).toEqual(renderedMaps[0]!.outline);
    }
    const alignedOutline = renderedMaps[0]!.outline!;
    expect(alignedOutline.length).toBeLessThanOrEqual(401);
    const center = alignedOutline.reduce((sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }), { x: 0, z: 0 });
    expect(center.x / alignedOutline.length).toBeCloseTo(500, 0);
    expect(center.z / alignedOutline.length).toBeCloseTo(300, 0);
  });
});
