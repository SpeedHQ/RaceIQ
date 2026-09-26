import { expect, test } from "bun:test";
import { getAccTracks } from "../../shared/racing/tracks/catalogs/acc";
import { getTrackBoundariesByOrdinal } from "../../shared/racing/tracks/geometry/extracted";
import { getTrackRacelineByOrdinal } from "../../shared/racing/tracks/recording/outlines";

const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

test("ACC bundled map edges follow the same closed track at driving width", () => {
  for (const ordinal of getAccTracks().keys()) {
    const boundaries = getTrackBoundariesByOrdinal(ordinal, "acc");
    expect(boundaries, `ACC track ${ordinal}`).not.toBeNull();
    const { leftEdge, rightEdge } = boundaries!;
    expect(leftEdge.length, `ACC track ${ordinal}`).toBe(rightEdge.length);
    expect(leftEdge.length, `ACC track ${ordinal}`).toBeGreaterThan(100);
    let widest = 0;
    let largestGap = 0;
    for (let i = 0; i < leftEdge.length; i++) {
      const next = (i + 1) % leftEdge.length;
      widest = Math.max(widest, distance(leftEdge[i], rightEdge[i]));
      largestGap = Math.max(largestGap, distance(leftEdge[i], leftEdge[next]), distance(rightEdge[i], rightEdge[next]));
    }
    expect(widest, `ACC track ${ordinal} paired edge width`).toBeLessThan(100);
    expect(largestGap, `ACC track ${ordinal} edge continuity`).toBeLessThan(15);
  }
});

test("ACC centre line stays on track near the timing origin", () => {
  for (const ordinal of getAccTracks().keys()) {
    const boundaries = getTrackBoundariesByOrdinal(ordinal, "acc")!;
    const racingLine = getTrackRacelineByOrdinal(ordinal, "acc")!;
    const center = boundaries.centerLine!;
    expect(center.length, `ACC track ${ordinal} centre`).toBeGreaterThan(100);
    expect(distance(center[0], racingLine[0]), `ACC track ${ordinal} centre start`).toBeLessThan(25);
    for (let i = 0; i < center.length; i += 50) {
      const left = boundaries.leftEdge[i];
      const right = boundaries.rightEdge[i];
      const width = distance(left, right);
      expect(distance(center[i], left), `ACC track ${ordinal} centre at ${i}`).toBeLessThan(width / 2 + 1);
    }
  }
});

test("ACC racing line stays near independent map-spline edges", () => {
  for (const ordinal of [0, 6, 35]) {
    const { leftEdge, rightEdge } = getTrackBoundariesByOrdinal(ordinal, "acc")!;
    const racingLine = getTrackRacelineByOrdinal(ordinal, "acc")!;
    expect(racingLine.length).toBeGreaterThan(100);
    for (let i = 0; i < racingLine.length; i += 40) {
      const point = racingLine[i];
      let closest = Infinity;
      for (let j = 0; j < leftEdge.length; j += 3) {
        const center = { x: (leftEdge[j].x + rightEdge[j].x) / 2, z: (leftEdge[j].z + rightEdge[j].z) / 2 };
        closest = Math.min(closest, distance(point, center));
      }
      expect(closest, `ACC track ${ordinal} raceline node ${i}`).toBeLessThan(35);
    }
  }
});
