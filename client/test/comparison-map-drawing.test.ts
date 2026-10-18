import { expect, test } from "bun:test";
import { drawTrackCanvas } from "../src/lib/comparison-utils";
import type { AlignedTrace } from "@raceiq/shared/racing/comparison/types";

function makeContext() {
  const fills: string[] = [];
  const arcs: Array<[number, number, number]> = [];
  const strokes: Array<{ color: string; lineWidth: number; moveCount: number; points: [number, number][] }> = [];
  let path: [number, number][] = [];
  let moveCount = 0;
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
