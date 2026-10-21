import { describe, expect, test } from "bun:test";
import { drawPitLines, type PitLine } from "client/src/lib/canvas/draw-track";

describe("iRacing pit-line rendering", () => {
  test("draws pit-road and merge lines as separate solid paths", () => {
    const strokes: string[] = [];
    const points: Array<[number, number]> = [];
    let activeStrokeStyle = "";
    const context = {
      beginPath: () => {},
      setLineDash: (dash: number[]) => expect(dash).toEqual([]),
      moveTo: (x: number, y: number) => points.push([x, y]),
      lineTo: (x: number, y: number) => points.push([x, y]),
      stroke: () => strokes.push(activeStrokeStyle),
      get strokeStyle() { return activeStrokeStyle; },
      set strokeStyle(value: string) { activeStrokeStyle = value; },
      lineWidth: 0,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;
    const lines: PitLine[] = [
      { kind: "pit-road", points: [{ x: 1, z: 2 }, { x: 3, z: 4 }] },
      { kind: "merge-line", points: [{ x: 5, z: 6 }, { x: 7, z: 8 }] },
    ];

    drawPitLines(context, lines, (x, z) => [x, z]);
    expect(strokes).toEqual(["var(--track-pit-road)", "var(--track-pit-exit)"]);
    expect(points).toEqual([[1, 2], [3, 4], [5, 6], [7, 8]]);
  });
});
