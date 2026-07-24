import { describe, expect, test } from "bun:test";
import { inputState, zoomViewport } from "../client/src/components/tunes/track-focus/TrackFocusZoom";

describe("inputState", () => {
  test("brake wins over throttle (trail-braking reads as braking)", () => {
    expect(inputState(0.5, 0.5)).toBe("brake");
    expect(inputState(0.2, 0)).toBe("brake");
  });
  test("throttle when only throttle applied", () => {
    expect(inputState(0, 0.4)).toBe("throttle");
  });
  test("coast when both below threshold", () => {
    expect(inputState(0.02, 0.02)).toBe("coast");
    expect(inputState(0, 0)).toBe("coast");
  });
});

function line(lapId: number, xs: number[], zs: number[]) {
  return { lapId, x: xs, z: zs };
}

describe("zoomViewport", () => {
  test("center is the mean of all laps at the nearest bin to cursorFrac", () => {
    // 3 bins (frac 0, 0.5, 1); cursorFrac=0.5 -> bin index 1.
    const lapLines = [line(1, [0, 10, 20], [0, 0, 0]), line(2, [0, 20, 20], [0, 0, 0])];
    const { center } = zoomViewport(lapLines, 0.5, 60);
    expect(center.x).toBeCloseTo(15, 5); // mean of 10 and 20
    expect(center.z).toBeCloseTo(0, 5);
  });

  test("rounds cursorFrac to the nearest bin", () => {
    const lapLines = [line(1, [0, 5, 100], [0, 0, 0])];
    // frac 0.9 over 3 bins -> idx = round(0.9*2) = 2 -> bin value 100.
    const { center } = zoomViewport(lapLines, 0.9, 60);
    expect(center.x).toBeCloseTo(100, 5);
  });

  test("inWindow keeps only points inside the ±radiusM box, plus one neighbor at the edges", () => {
    // A straight line along x from 0..200 in steps of 20 (11 points), cursor at
    // the midpoint (x=100). radius=30 -> window is [70,130].
    const xs = Array.from({ length: 11 }, (_, i) => i * 20);
    const zs = xs.map(() => 0);
    const lapLines = [line(1, xs, zs)];
    const { inWindow } = zoomViewport(lapLines, 0.5, 30);
    expect(inWindow.length).toBe(1);
    const pts = inWindow[0].points.map((p) => p.x);
    // Inside points: 80,100,120. Neighbors just outside the window on each
    // side (60 before, 140 after) should be included so segments reach the edge.
    expect(pts).toContain(80);
    expect(pts).toContain(100);
    expect(pts).toContain(120);
    expect(pts).toContain(60);
    expect(pts).toContain(140);
    expect(pts).not.toContain(40);
    expect(pts).not.toContain(160);
  });

  test("empty lapLines returns a zero center, no windows, no edges", () => {
    const { center, inWindow, edges } = zoomViewport([], 0.5, 60);
    expect(center).toEqual({ x: 0, z: 0 });
    expect(inWindow).toEqual([]);
    expect(edges).toBeNull();
  });

  test("edges are clipped to the same window as the lap lines", () => {
    const xs = Array.from({ length: 11 }, (_, i) => i * 20);
    const zs = xs.map(() => 0);
    const lapLines = [line(1, xs, zs)]; // cursor midpoint -> center x=100
    const edges = {
      left: xs.map((x) => ({ x, z: 5 })),
      right: xs.map((x) => ({ x, z: -5 })),
    };
    const { edges: win } = zoomViewport(lapLines, 0.5, 30, edges);
    expect(win).not.toBeNull();
    const leftXs = win!.left.map((p) => p.x);
    // Same window [70,130]: inside 80,100,120 + neighbors 60,140.
    expect(leftXs).toContain(100);
    expect(leftXs).toContain(60);
    expect(leftXs).toContain(140);
    expect(leftXs).not.toContain(40);
    expect(win!.left.every((p) => p.z === 5)).toBe(true);
    expect(win!.right.every((p) => p.z === -5)).toBe(true);
  });

  test("edges omitted yields null edges", () => {
    const lapLines = [line(1, [0, 10, 20], [0, 0, 0])];
    expect(zoomViewport(lapLines, 0.5, 60).edges).toBeNull();
  });

  test("a lap entirely outside the window contributes no points", () => {
    const near = line(1, [0, 0, 0], [0, 0, 0]);
    const far = line(2, [1000, 1000, 1000], [1000, 1000, 1000]);
    const { inWindow } = zoomViewport([near, far], 0, 60);
    const farWindow = inWindow.find((w) => w.lapId === 2)!;
    expect(farWindow.points.length).toBe(0);
  });
});
