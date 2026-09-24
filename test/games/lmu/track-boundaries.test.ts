import { describe, expect, test } from "bun:test";
import { getLMUTrackBoundaries } from "../../../shared/games/lmu/track-boundaries";


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
});
