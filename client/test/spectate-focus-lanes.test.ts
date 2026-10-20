import { describe, expect, it } from "bun:test";
import { FOCUS_ZOOM_SNAP_ZONE_END, focusLaneWidth, focusZoomBlend, offsetFocusLane, projectFocusCenterline, sampleFocusLane, smallestAvailableModelLength, zoomIndicatorPosition } from "../src/components/comparison/spectate/spectate-focus-lanes";

describe("projectFocusCenterline", () => {
  it("projects onto nearest center segment, stripping racing-line lateral jitter", () => {
    const result = projectFocusCenterline(
      [{ x: 2, z: 0 }, { x: 8, z: 1 }, { x: 2, z: 2 }],
      [{ x: 0, z: 0 }, { x: 0, z: 2 }],
    );
    expect(result.map(point => point && ({ x: point.x, z: point.z }))).toEqual([
      { x: 0, z: 0 }, { x: 0, z: 1 }, { x: 0, z: 2 },
    ]);
  });

  it("orients tangent with recorded travel when centerline order is reversed", () => {
    const result = projectFocusCenterline(
      [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }],
      [{ x: 0, z: 2 }, { x: 0, z: 0 }],
    );
    expect(result[1]?.tz).toBeCloseTo(1);
  });

  it("clamps projection to centerline endpoints without extrapolating", () => {
    const result = projectFocusCenterline(
      [{ x: 2, z: -4 }, { x: 2, z: 4 }],
      [{ x: 0, z: 0 }, { x: 0, z: 2 }],
    );
    expect(result[0]).toMatchObject({ x: 0, z: 0 });
    expect(result[1]).toMatchObject({ x: 0, z: 2 });
  });

  it("returns null for invalid samples or invalid/degenerate centerline geometry", () => {
    expect(projectFocusCenterline([{ x: Number.NaN, z: 0 }], [{ x: 0, z: 0 }, { x: 0, z: 1 }])).toEqual([null]);
    expect(projectFocusCenterline([{ x: 0, z: 0 }], [])).toEqual([null]);
    expect(projectFocusCenterline([{ x: 0, z: 0 }], [{ x: 0, z: 0 }, { x: 0, z: 0 }])).toEqual([null]);
  });

  it("preserves inferred travel direction for stationary recorded samples", () => {
    const result = projectFocusCenterline(
      [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 2 }],
      [{ x: 0, z: 2 }, { x: 0, z: 0 }],
    );
    expect(result[2]?.tz).toBeCloseTo(1);
  });

  it("infers forward travel for an initially stationary prefix on a reversed centerline", () => {
    const result = projectFocusCenterline(
      [{ x: 1, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }],
      [{ x: 0, z: 2 }, { x: 0, z: 0 }],
    );
    expect(result[0]?.tz).toBeCloseTo(1);
    expect(result[1]?.tz).toBeCloseTo(1);
  });
});

describe("offsetFocusLane", () => {
  const right = { x: 1, y: 0, z: 0 };
  const up = { x: 0, y: 0, z: -1 };

  it("puts A on driving-left and B on driving-right while preserving CSS-pixel magnitude", () => {
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
    offsetFocusLane(a, { tx: 0, tz: -1 }, right, up, 5, 0.2);
    offsetFocusLane(b, { tx: 0, tz: -1 }, right, up, -5, 0.2);
    expect(a.x).toBeCloseTo(-1);
    expect(b.x).toBeCloseTo(1);
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(5 * 0.2);
    const secondZoom = { x: 0, y: 0, z: 0 };
    offsetFocusLane(secondZoom, { tx: 0, tz: -1 }, right, up, 5, 0.08);
    expect(Math.hypot(secondZoom.x, secondZoom.y, secondZoom.z) / 0.08).toBeCloseTo(5);
    const tangent = { x: 0, y: 0, z: 0 };
    offsetFocusLane(tangent, { tx: 1, tz: 0 }, right, up, 5, 0.2);
    expect(tangent.x * 1 + tangent.z * 0).toBeCloseTo(0);
    expect(tangent.z, "Driving-left points up-screen when travelling right").toBeLessThan(0);
  });

  it("keeps lanes perpendicular and equally separated when the camera is tilted", () => {
    const k = Math.SQRT1_2;
    const tiltedUp = { x: 0, y: k, z: -k };
    const out = { x: 0, y: 0, z: 0 };
    offsetFocusLane(out, { tx: 1, tz: 1 }, right, tiltedUp, 5, 0.2);
    const screenX = out.x, screenY = out.y * k - out.z * k;
    expect(screenX - screenY * k).toBeCloseTo(0);
    expect(Math.hypot(screenX, screenY) / 0.2).toBeCloseTo(5);
    expect(out.y + out.z).toBeCloseTo(0);
    expect(-out.x + out.z).toBeLessThan(0);
  });

  it("keeps output finite for degenerate projected tangents", () => {
    const out = { x: 0, y: 0, z: 0 };
    offsetFocusLane(out, { tx: 0, tz: 0 }, right, up, 5, 0.2);
    expect([out.x, out.y, out.z].every(Number.isFinite)).toBe(true);
  });
});

describe("sampleFocusLane", () => {
  const runs = [
    [{ x: -5, y: 1, z: 0, time: 0, endTime: 1 }, { x: -5, y: 3, z: 20, time: 3, endTime: 3 }],
    [{ x: -5, y: 4, z: 40, time: 5, endTime: 5 }, { x: -5, y: 6, z: 60, time: 7, endTime: 7 }],
  ];

  it("anchors labels by interpolating the already-offset rendered segment", () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(sampleFocusLane(out, runs, 2)).toBe(true);
    expect(out).toEqual({ x: -5, y: 2, z: 10 });
  });

  it("holds position throughout coalesced stationary telemetry", () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(sampleFocusLane(out, runs, 0.75)).toBe(true);
    expect(out).toEqual({ x: -5, y: 1, z: 0 });
  });

  it("does not bridge recording gaps", () => {
    const out = { x: 123, y: 456, z: 789 };
    expect(sampleFocusLane(out, runs, 4)).toBe(false);
    expect(out).toEqual({ x: 123, y: 456, z: 789 });
  });

  it("clamps held poses at the first and last recorded endpoints", () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(sampleFocusLane(out, runs, -1)).toBe(true);
    expect(out).toEqual({ x: -5, y: 1, z: 0 });
    expect(sampleFocusLane(out, runs, 8)).toBe(true);
    expect(out).toEqual({ x: -5, y: 6, z: 60 });
  });

  it("uses the next run at an exact recording boundary", () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(sampleFocusLane(out, runs, 5)).toBe(true);
    expect(out).toEqual({ x: -5, y: 4, z: 40 });
  });

  it("rejects missing paths and non-finite replay times", () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(sampleFocusLane(out, [], 0)).toBe(false);
    expect(sampleFocusLane(out, runs, Number.NaN)).toBe(false);
  });
});

describe("zoom interpolation", () => {
  it("starts blending farther out and eases continuously to the close-up threshold", () => {
    expect(focusZoomBlend(48)).toBe(0);
    expect(focusZoomBlend(16)).toBe(1);
    expect(focusZoomBlend(Math.sqrt(48 * 16))).toBeCloseTo(0.5);
    expect(focusZoomBlend(48 - 0.001)).toBeLessThan(0.000001);
    expect(focusZoomBlend(16 + 0.001)).toBeGreaterThan(0.999999);
    const pixels = [48, 40, 32, 24, 16];
    const outward = pixels.map(focusZoomBlend);
    expect(outward.every((value, i) => !i || value > outward[i - 1])).toBe(true);
    expect([...pixels].reverse().map(focusZoomBlend)).toEqual([...outward].reverse());
  });
  it("ignores failed and invalid model lengths when selecting a shared zoom scale", () => {
    expect(smallestAvailableModelLength([0, 2], true, true)).toBe(2);
    expect(smallestAvailableModelLength([Number.NaN, 2], true, true)).toBe(2);
    expect(smallestAvailableModelLength([0, 0], true, true)).toBe(Infinity);
    expect(smallestAvailableModelLength([1, 2], true, true)).toBe(1);
  });

  it("thins focus lanes as camera zooms farther out", () => {
    expect(focusLaneWidth(1.5, 16)).toBe(1.5);
    expect(focusLaneWidth(1.5, 8)).toBe(0.75);
    expect(focusLaneWidth(1.5, 0)).toBe(0.375);
  });

  it("maps zoom position across the snap zone and farther zoom range", () => {
    expect(zoomIndicatorPosition(48)).toBe(0);
    expect(zoomIndicatorPosition(16)).toBeCloseTo(FOCUS_ZOOM_SNAP_ZONE_END);
    expect(zoomIndicatorPosition(8)).toBe(1);
    expect(zoomIndicatorPosition(4)).toBe(1);
    expect(zoomIndicatorPosition(96)).toBe(0);
  });

  it("places badges by continuous distance rather than irregular packet timing", () => {
    const out = { x: 0, y: 0, z: 0 };
    const path = [[
      { x: -14, y: 0, z: 0, time: 0, endTime: 0, distance: 0, endDistance: 0 },
      { x: -14, y: 0, z: 100, time: 0.08, endTime: 0.08, distance: 100, endDistance: 100 },
    ]];
    for (const distance of [10, 30, 50, 70, 90]) {
      expect(sampleFocusLane(out, path, distance, "distance")).toBe(true);
      expect(out).toEqual({ x: -14, y: 0, z: distance });
    }
  });
});
