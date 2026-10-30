import { expect, test } from "bun:test";
import { drawTrackCanvas } from "../src/lib/comparison-utils";
import type { AlignedTrace } from "@raceiq/shared/racing/comparison/types";

function makeContext() {
  const fills: string[] = [];
  const arcs: Array<[number, number, number]> = [];
  const strokes: Array<{ color: string; lineWidth: number; moveCount: number; points: [number, number][] }> = [];
  const rotations: number[] = [];
  let path: [number, number][] = [];
  let moveCount = 0;
  return {
    fills,
    arcs,
    strokes,
    rotations,
    ctx: {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      clearRect() {},
      beginPath() { path = []; moveCount = 0; },
      moveTo(x: number, y: number) { moveCount++; path.push([x, y]); },
      lineTo(x: number, y: number) { path.push([x, y]); },
      closePath() {},
      arc(x: number, y: number, radius: number) {
        arcs.push([x, y, radius]);
      },
      stroke(this: { strokeStyle: string; lineWidth: number }) {
        strokes.push({ color: this.strokeStyle, lineWidth: this.lineWidth, moveCount, points: [...path] });
      },
      fill(this: { fillStyle: string }) {
        fills.push(this.fillStyle);
      },
      save() {},
      restore() {},
      translate() {},
      rotate(angle: number) { rotations.push(angle); },
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

function drawLapAMoveCount(breakAtInvalidPositions: boolean): number {
  const traces = makeTraces();
  traces.distance = [0, 1, 2, 3];
  traces.positionXA = [1, 2, Number.NaN, 4];
  traces.positionZA = [1, 2, Number.NaN, 4];
  traces.positionXB = [1, 2, 3, 4];
  traces.positionZB = [1, 2, 3, 4];
  const { ctx, strokes } = makeContext();
  drawTrackCanvas(ctx, 400, 200, [], traces, null, null, undefined, false, null, undefined, true, false, breakAtInvalidPositions);
  return strokes.find(({ color }) => color === "var(--comparison-lap-a)")!.moveCount;
}

test("iRacing map starts a new path across missing GPS samples", () => {
  expect(drawLapAMoveCount(true)).toBe(2);
});

test("other game maps keep existing path behavior", () => {
  expect(drawLapAMoveCount(false)).toBe(1);
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

function drawDirections(traces: AlignedTrace, follow = false, telX = (x: number) => x, distance = 10) {
  const result = makeContext();
  drawTrackCanvas(result.ctx, 400, 300, [], traces, distance,
    { centerX: 2, centerZ: 1, range: 20 }, undefined, follow, null, telX, true, false, true, true);
  return result;
}

test("iRacing chevrons follow each lap's path instead of opposing simulator yaw", () => {
  const traces = makeTraces();
  traces.distance = [0, 10, 20];
  traces.positionXA = [3, 2, 1];
  traces.positionZA = [1, 1, 1];
  traces.positionXB = [2, 2, 2];
  traces.positionZB = [1, 2, 3];
  traces.yawA = traces.yawB = [Number.NaN, Number.NaN, Number.NaN];
  const { strokes, arcs } = drawDirections(traces);
  const a = strokes.filter((s) => s.color === "var(--comparison-lap-a)").at(-1)!;
  const b = strokes.filter((s) => s.color === "var(--comparison-lap-b)").at(-1)!;
  expect(a.points[1][0]).toBeGreaterThan(a.points[0][0]);
  expect(a.points[1][1]).toBeCloseTo((a.points[0][1] + a.points[2][1]) / 2);
  expect(b.points[1][1]).toBeGreaterThan(b.points[0][1]);
  expect(b.points[1][0]).toBeCloseTo((b.points[0][0] + b.points[2][0]) / 2);
  expect(strokes.some((s) => s.color === "var(--app-text)")).toBe(false);
  expect(arcs).toEqual([]);
});

test("iRacing follow camera points path direction up, including mirrored coordinates", () => {
  const traces = makeTraces();
  traces.distance = [0, 10, 20];
  traces.positionXA = [3, 2, 1];
  traces.positionZA = [1, 1, 1];
  expect(drawDirections(traces, true).rotations[0]).toBeCloseTo(-Math.PI / 2);
  expect(drawDirections(traces, true, (x) => -x).rotations[0]).toBeCloseTo(-3 * Math.PI / 2);
});

test("iRacing stationary or isolated positions retain dots without invented directions", () => {
  const traces = makeTraces();
  traces.distance = [0, 10, 20];
  traces.positionXA = [2, 2, 2];
  traces.positionZA = [1, 1, 1];
  traces.positionXB = [Number.NaN, 2, Number.NaN];
  traces.positionZB = [Number.NaN, 1, Number.NaN];
  const { strokes, arcs, rotations } = drawDirections(traces, true);
  expect(arcs).toHaveLength(2);
  expect(rotations).toEqual([]);
  expect(strokes.some((s) => s.color === "var(--app-text)")).toBe(false);
});

test("iRacing direction handles repeated samples and one-sided lap endpoints", () => {
  const traces = makeTraces();
  traces.distance = [0, 10, 20];
  traces.positionXA = [3, 2, 2];
  traces.positionZA = [1, 1, 1];
  for (const distance of [0, 10, 20]) {
    const { strokes } = drawDirections(traces, false, (x) => x, distance);
    const a = strokes.filter((s) => s.color === "var(--comparison-lap-a)").at(-1)!;
    expect(a.points[1][0]).toBeGreaterThan(a.points[0][0]);
  }
});
