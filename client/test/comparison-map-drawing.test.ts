import { expect, test } from "bun:test";
import { drawTrackCanvas } from "../src/lib/comparison-utils";
import type { AlignedTrace } from "@raceiq/shared/racing/comparison/types";

function makeContext() {
  const fills: string[] = [];
  const arcs: Array<[number, number, number]> = [];
  const strokes: Array<{ color: string; lineWidth: number; points: [number, number][] }> = [];
  let path: [number, number][] = [];
  return {
    fills,
    arcs,
    strokes,
    ctx: {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      clearRect() {},
      beginPath() { path = []; },
      moveTo(x: number, y: number) { path.push([x, y]); },
      lineTo(x: number, y: number) { path.push([x, y]); },
      closePath() {},
      arc(x: number, y: number, radius: number) {
        arcs.push([x, y, radius]);
      },
      stroke(this: { strokeStyle: string; lineWidth: number }) {
        strokes.push({ color: this.strokeStyle, lineWidth: this.lineWidth, points: [...path] });
      },
      fill(this: { fillStyle: string }) {
        fills.push(this.fillStyle);
      },
      save() {},
      restore() {},
      translate() {},
      rotate() {},
    } as unknown as CanvasRenderingContext2D,
  };
}

function makeTraces(): AlignedTrace {
  return {
    distance: [0, 10],
    sourceIndicesA: [0, 1],
    sourceIndicesB: [0, 1],
    speedA: [0, 0],
    speedB: [0, 0],
    throttleA: [0, 0],
    throttleB: [0, 0],
    brakeA: [0, 0],
    brakeB: [0, 0],
    steerA: [0, 0],
    steerB: [0, 0],
    gearA: [0, 0],
    gearB: [0, 0],
    rpmA: [0, 0],
    rpmB: [0, 0],
    positionXA: [0, 10],
    positionXB: [0, 10],
    positionZA: [0, 10],
    positionZB: [0, 10],
    yawA: [0, 0],
    yawB: [0, 0],
    elapsedTimeA: [0, 1],
    elapsedTimeB: [0, 1],
  };
}

test("overview uses both track extents instead of collapsing into a square fit", () => {
  const { ctx, strokes } = makeContext();
  drawTrackCanvas(ctx, 400, 200, [{ x: 0, z: 0 }, { x: 100, z: 50 }], makeTraces(), null, null);
  const outline = strokes.find(({ color }) => color === "var(--track-outline)")!;
  const xs = outline.points.map(([x]) => x);
  const ys = outline.points.map(([, y]) => y);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(250);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(120);
});

test("comparison map draws track-boundary edges", () => {
  const { ctx, fills, strokes } = makeContext();
  drawTrackCanvas(
    ctx,
    400,
    200,
    [{ x: 0, z: 0 }, { x: 100, z: 50 }],
    makeTraces(),
    null,
    null,
    undefined,
    false,
    { leftEdge: [{ x: 0, z: 5 }, { x: 100, z: 55 }], rightEdge: [{ x: 0, z: -5 }, { x: 100, z: 45 }], centerLine: [{ x: 0, z: 0 }, { x: 100, z: 50 }], pitLane: null, coordSystem: "test" },
  );
  expect(fills).toContain("color-mix(in srgb, var(--track-surface) 24%, transparent)");
  expect(strokes.some(({ color }) => color === "color-mix(in srgb, var(--track-edge) 68%, transparent)")).toBe(true);
});

test("comparison map draws lap-to-lap line differences and fastest-lap reference", () => {
  const { ctx, strokes } = makeContext();
  const traces = makeTraces();
  traces.positionXA = [10, 30];
  traces.positionZA = [10, 10];
  traces.positionXB = [10, 30];
  traces.positionZB = [10, 40];
  drawTrackCanvas(ctx, 400, 200, [{ x: 0, z: 0 }, { x: 100, z: 50 }], traces, null, null, undefined, false, null, (x) => x, false, false, [{ x: 20, z: 15 }, { x: 40, z: 15 }]);
  const difference = strokes.find(({ color }) => color === "color-mix(in srgb, var(--app-text) 55%, transparent)");
  expect(difference?.points.length).toBe(2);
  expect(difference?.points[0]).not.toEqual(difference?.points[1]);
  expect(strokes.some(({ color }) => color === "var(--track-racing-line)")).toBe(true);
});
test("overview can suppress static segment markers while keeping start marker", () => {
  const { ctx, fills } = makeContext();

  drawTrackCanvas(
    ctx,
    400,
    300,
    [
      { x: 0, z: 0 },
      { x: 10, z: 10 },
    ],
    makeTraces(),
    null,
    null,
    [{ x: 5, z: 5, type: "corner", label: "Turn 1" }],
    false,
    null,
    (x) => x,
    false,
    false,
  );

  expect(fills).not.toContain("var(--track-corner-marker)");
  expect(fills).toContain("var(--track-start)");
});

test("overview shows one white hover dot at the current distance", () => {
  const { ctx, fills } = makeContext();

  drawTrackCanvas(
    ctx,
    400,
    300,
    [
      { x: 0, z: 0 },
      { x: 10, z: 10 },
    ],
    makeTraces(),
    5,
    null,
    undefined,
    false,
    null,
    (x) => x,
    false,
    false,
  );

  expect(fills).toContain("var(--app-text)");
  expect(fills).not.toContain("var(--comparison-lap-a)");
  expect(fills).not.toContain("var(--comparison-lap-b)");
});

test("zoomed view keeps both lap hover dots", () => {
  const { ctx, fills } = makeContext();

  drawTrackCanvas(
    ctx,
    400,
    300,
    [
      { x: 0, z: 0 },
      { x: 10, z: 10 },
    ],
    makeTraces(),
    5,
    { centerX: 5, centerZ: 5, range: 10 },
    undefined,
    false,
    null,
    (x) => x,
    false,
    false,
  );

  expect(fills).toContain("var(--comparison-lap-a)");
  expect(fills).toContain("var(--comparison-lap-b)");
});

test("zoomed overlapping lap hover dots share one position", () => {
  const { ctx, arcs } = makeContext();

  drawTrackCanvas(
    ctx,
    400,
    300,
    [
      { x: 0, z: 0 },
      { x: 10, z: 10 },
    ],
    makeTraces(),
    5,
    { centerX: 5, centerZ: 5, range: 10 },
    undefined,
    false,
    null,
    (x) => x,
    false,
    false,
  );

  const dots = arcs.slice(-2);
  expect(dots).toHaveLength(2);
  expect(dots[0]?.slice(0, 2)).toEqual(dots[1]?.slice(0, 2));
});
