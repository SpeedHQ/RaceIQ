import { expect, test } from "bun:test";
import { drawTrackCanvas } from "../src/lib/comparison-utils";
import type { AlignedTrace } from "@shared/racing/comparison/types";

function makeContext() {
   const fills: string[] = [];
   const arcs: Array<[number, number, number]> = [];
   return {
     fills,
     arcs,
     ctx: {
       fillStyle: "",
       strokeStyle: "",
       lineWidth: 1,
       globalAlpha: 1,
       clearRect() {},
       beginPath() {},
       moveTo() {},
       lineTo() {},
       closePath() {},
       arc(x: number, y: number, radius: number) {
         arcs.push([x, y, radius]);
       },
       stroke() {},
       fill(this: { fillStyle: string }) { fills.push(this.fillStyle); },
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
test("overview can suppress static segment markers while keeping start marker", () => {
  const { ctx, fills } = makeContext();

  drawTrackCanvas(ctx, 400, 300, [{ x: 0, z: 0 }, { x: 10, z: 10 }], makeTraces(), null, null, [{ x: 5, z: 5, type: "corner", label: "Turn 1" }], false, null, (x) => x, false, false);

  expect(fills).not.toContain("var(--track-corner-marker)");
  expect(fills).toContain("var(--track-start)");
});

test("overview shows one white hover dot at the current distance", () => {
  const { ctx, fills } = makeContext();

  drawTrackCanvas(ctx, 400, 300, [{ x: 0, z: 0 }, { x: 10, z: 10 }], makeTraces(), 5, null, undefined, false, null, (x) => x, false, false);

  expect(fills).toContain("var(--app-text)");
  expect(fills).not.toContain("var(--comparison-lap-a)");
  expect(fills).not.toContain("var(--comparison-lap-b)");
});

test("zoomed view keeps both lap hover dots", () => {
  const { ctx, fills } = makeContext();

  drawTrackCanvas(ctx, 400, 300, [{ x: 0, z: 0 }, { x: 10, z: 10 }], makeTraces(), 5, { centerX: 5, centerZ: 5, range: 10 }, undefined, false, null, (x) => x, false, false);

  expect(fills).toContain("var(--comparison-lap-a)");
  expect(fills).toContain("var(--comparison-lap-b)");
});

test("zoomed overlapping lap hover dots share one position", () => {
  const { ctx, arcs } = makeContext();

  drawTrackCanvas(ctx, 400, 300, [{ x: 0, z: 0 }, { x: 10, z: 10 }], makeTraces(), 5, { centerX: 5, centerZ: 5, range: 10 }, undefined, false, null, (x) => x, false, false);

  const dots = arcs.slice(-2);
  expect(dots).toHaveLength(2);
  expect(dots[0]?.slice(0, 2)).toEqual(dots[1]?.slice(0, 2));
});
