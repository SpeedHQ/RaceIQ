import { describe, expect, test } from "bun:test";
import { getLMUTrackBoundaries } from "@raceiq/game-lmu-metadata/track-boundaries";


interface Point {
  x: number;
  z: number;
}


function midpointRms(left: Point[], right: Point[], center: Point[]): number {
  const count = Math.min(left.length, right.length, center.length);
  let squaredDistance = 0;
  for (let index = 0; index < count; index += 1) {
    const x = (left[index].x + right[index].x) / 2;
    const z = (left[index].z + right[index].z) / 2;
    squaredDistance += (x - center[index].x) ** 2 + (z - center[index].z) ** 2;
  }
  return Math.sqrt(squaredDistance / count);
}

describe("LMU track boundaries", () => {
  test("aligns extracted track limits with their catalog center line", () => {
    const boundaries = getLMUTrackBoundaries("spa_2023/spawec");
    expect(boundaries).not.toBeNull();
    expect(boundaries!.centerLine).toBeDefined();
    expect(
      midpointRms(
        boundaries!.leftEdge,
        boundaries!.rightEdge,
        boundaries!.centerLine!,
      ),
    ).toBeLessThan(0.01);
  });
  test("loads racing line from shipped SVG separately from center line", () => {
    const boundaries = getLMUTrackBoundaries("spa_2023/spawec");
    expect(boundaries?.raceLine?.length).toBeGreaterThan(10);
    expect(boundaries!.raceLine).not.toEqual(boundaries!.centerLine);
  });
  test("preserves native Bahrain positions beside the left edge and outside track limits", () => {
    const boundaries = getLMUTrackBoundaries("bahrainwec_2023/bahrainwec_paddock")!;
    const lateralOffset = (point: Point, edge: Point[]) => {
      let nearestDistance = Infinity;
      let offset = NaN;
      for (let index = 1; index < edge.length; index++) {
        const start = edge[index - 1];
        const dx = edge[index].x - start.x;
        const dz = edge[index].z - start.z;
        const length = Math.hypot(dx, dz);
        if (length === 0) continue;
        const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / (length * length)));
        const distance = Math.hypot(point.x - start.x - t * dx, point.z - start.z - t * dz);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          offset = ((point.x - start.x) * dz - (point.z - start.z) * dx) / length;
        }
      }
      return offset;
    };
    // Native position from session 10, lap 30, on the opening straight.
    const recorded = { x: -218.6667, z: -270.3658 };
    expect(lateralOffset(recorded, boundaries.leftEdge)).toBeCloseTo(3.189, 2);
    expect(lateralOffset(recorded, boundaries.centerLine!)).toBeCloseTo(-4.336, 2);
    expect(lateralOffset(recorded, boundaries.rightEdge)).toBeCloseTo(-11.861, 2);
    // Moving ten meters left must remain outside, not become a new centerline.
    const outside = { x: recorded.x - 10, z: recorded.z };
    expect(lateralOffset(outside, boundaries.leftEdge)).toBeLessThan(-6);
    expect(lateralOffset(outside, boundaries.rightEdge)).toBeLessThan(-20);
  });
});
