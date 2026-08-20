import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SemanticTelemetrySample } from "../../shared/racing/comparison/types";
import type { SemanticAnalysisFrame, TrackMapLayerKey, TrackMapLayerState, TrackMapProps } from "../src/components/track-map/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const renderedMaps: TrackMapProps[] = [];
mock.module("@/components/track-map/TrackMapCanvas", () => ({
  TrackMapCanvas: (props: TrackMapProps) => {
    renderedMaps.push(props);
    return null;
  },
}));
interface CapturedLayerMenu {
  layers: TrackMapLayerState;
  items: readonly { label: string }[];
  onLayerChange: (key: TrackMapLayerKey, checked: boolean) => void;
  ariaLabel?: string;
}

const renderedLayerMenus: CapturedLayerMenu[] = [];
mock.module("@/components/track-map/TrackMapLayerMenu", () => ({
  TrackMapLayerMenu: (props: CapturedLayerMenu) => {
    renderedLayerMenus.push(props);
    return createElement("button", { "aria-label": props.ariaLabel }, "Layers");
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
  beforeEach(() => {
    renderedMaps.splice(0);
    renderedLayerMenus.splice(0);
  });

  test("uses bounded telemetry geometry without transforming comparison laps", () => {
    const pointCount = 4_001;
    const outline = Array.from({ length: pointCount }, (_, index) => {
      const angle = (index / pointCount) * Math.PI * 2;
      return { x: Math.cos(angle) * 20, z: Math.sin(angle) * 10 };
    });
    const telemetry = outline.map((point, index) => sample(point.x + 500, point.z + 300, index));

    const markup = renderToStaticMarkup(
      createElement(CompareTrackMap, {
        outline,
        series: [
          { telemetry, distanceGrid: [], sourceIndices: [], color: "orange", label: "A" },
          { telemetry, distanceGrid: [], sourceIndices: [], color: "blue", label: "B" },
          { telemetry, distanceGrid: [], sourceIndices: [], color: "green", label: "C" },
        ],
        segments: [],
        hoveredDistanceRef: { current: null },
        redrawRef: { current: null },
      }),
    );

    expect(renderedMaps).toHaveLength(2);
    expect(markup).toContain('aria-label="Zoom out overview map"');
    expect(markup).toContain('aria-label="Zoom in zoomed map"');
    expect(markup).toContain('aria-label="Overview map layers"');
    expect(markup).toContain('aria-label="Zoomed map layers"');
    expect(renderedLayerMenus).toHaveLength(2);
    expect(renderedLayerMenus[0]!.layers).not.toBe(renderedLayerMenus[1]!.layers);
    expect(renderedLayerMenus[0]!.layers).toMatchObject({ imagery: true, outline: true, trace: true, segments: true, inputs: false });
    expect(renderedLayerMenus[1]!.layers).toMatchObject({ imagery: true, outline: false, trace: true, segments: false, inputs: true });
    expect(renderedLayerMenus[0]!.items.map((item) => item.label)).toEqual(["Aerial background", "Track outline", "Comparison lines", "Segment markers", "Input overlay", "Boundaries", "Pit lane"]);
    expect(renderedMaps[0]!.layers).not.toBe(renderedMaps[1]!.layers);
    expect(renderedMaps[0]!.layers.outline).toBe(true);
    expect(renderedMaps[1]!.layers.outline).toBe(false);
    for (const map of renderedMaps) {
      const mapTelemetry = map.telemetry as SemanticAnalysisFrame[];
      expect(mapTelemetry[0]!.values["motion.position-x"]).toBe(telemetry[0]!.values["motion.position-x"]);
      expect(mapTelemetry[0]!.values["motion.position-z"]).toBe(telemetry[0]!.values["motion.position-z"]);
      expect(map.outline).toEqual(renderedMaps[0]!.outline);
      expect(map.onZoomChange).toBeFunction();
    }
    const alignedOutline = renderedMaps[0]!.outline!;
    expect(alignedOutline.length).toBeLessThanOrEqual(401);
    const center = alignedOutline.reduce((sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }), { x: 0, z: 0 });
    expect(center.x / alignedOutline.length).toBeCloseTo(500, 0);
    expect(center.z / alignedOutline.length).toBeCloseTo(300, 0);
  });
});
