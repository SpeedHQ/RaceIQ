import { describe, test, expect } from "bun:test";
import {
  filterByDistance,
  filterByDistanceIndexed,
  buildTrackIndex,
} from "../client/src/lib/wireframe-utils";

// Deep-equal helper — bun:test's toEqual already does structural compare,
// but segment arrays are nested so we just sanity-check lengths and
// first/last points to keep failures readable when they happen.
function segmentsMatch(
  a: [number, number, number][][],
  b: [number, number, number][][],
): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].length).toBe(b[i].length);
    for (let j = 0; j < a[i].length; j++) {
      const [ax, ay, az] = a[i][j];
      const [bx, by, bz] = b[i][j];
      expect(ax).toBeCloseTo(bx, 10);
      expect(ay).toBeCloseTo(by, 10);
      expect(az).toBeCloseTo(bz, 10);
    }
  }
}

// Generate a dense S-curve outline so segment breaks happen mid-chunk
// for at least some query positions.
function sCurveOutline(n = 300, spacing = 2): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * spacing;
    pts.push({ x: Math.sin(t * 0.05) * 40, z: t });
  }
  return pts;
}

describe("filterByDistanceIndexed", () => {
  test("produces identical output to filterByDistance on an S-curve", () => {
    const pts = sCurveOutline();
    const index = buildTrackIndex(pts);

    // Sample several car positions along the curve with varying yaw —
    // enough to cover cases where a query window falls entirely inside
    // a single chunk, spans multiple chunks, and lands on a segment
    // break.
    const cases = [
      { cx: 0, cz: 0, yaw: 0 },
      { cx: 0, cz: 200, yaw: Math.PI / 4 },
      { cx: 10, cz: 400, yaw: Math.PI / 2 },
      { cx: -5, cz: 500, yaw: -Math.PI / 3 },
      { cx: 0, cz: 599, yaw: Math.PI },
    ];

    for (const { cx, cz, yaw } of cases) {
      const ref = filterByDistance(pts, cx, cz, yaw, -0.44);
      const indexed = filterByDistanceIndexed(index, cx, cz, yaw, -0.44);
      segmentsMatch(indexed, ref);
    }
  });

  test("skips chunks whose AABB doesn't overlap the query window", () => {
    // Two clusters far apart: near cluster in range, far cluster 10 km away.
    const near: { x: number; z: number }[] = [];
    const far: { x: number; z: number }[] = [];
    for (let i = 0; i < 200; i++) {
      near.push({ x: 0, z: i * 1.5 }); // ~300 m straight line at origin
      far.push({ x: 10_000, z: i * 1.5 }); // same shape, 10 km east
    }
    const pts = [...near, ...far];
    const index = buildTrackIndex(pts, 32); // small chunks so far cluster is several chunks

    // Query at the middle of the near cluster, facing +Z.
    const segs = filterByDistanceIndexed(index, 0, 150, 0, -0.44);

    // Should find segments — all inside the near cluster.
    expect(segs.length).toBeGreaterThan(0);

    // None of the emitted points should correspond to the far cluster.
    // Emitted points are in car-local space (forward, y, lateral). At the
    // car's position (0, 150) facing +Z, a point at world (10000, ...)
    // would translate to localLat ~= 10000, way outside the 30 m lateral
    // window — so the exact filter would reject it anyway. The point of
    // this test is that we confirm the result matches the reference
    // (showing correctness is preserved even when whole chunks are
    // skipped by the AABB pre-filter).
    const ref = filterByDistance(pts, 0, 150, 0, -0.44);
    segmentsMatch(segs, ref);
  });

  test("empty and tiny inputs are safe", () => {
    expect(filterByDistanceIndexed(buildTrackIndex([]), 0, 0, 0, 0)).toEqual([]);
    expect(
      filterByDistanceIndexed(buildTrackIndex([{ x: 0, z: 0 }]), 0, 0, 0, 0),
    ).toEqual([]); // single point can't form a segment (needs length > 1)
  });
});

describe("buildTrackIndex", () => {
  test("chunks cover every input point exactly once", () => {
    const pts = sCurveOutline(250, 1);
    const index = buildTrackIndex(pts, 64);

    // No gaps or overlaps
    let expected = 0;
    for (const chunk of index.chunks) {
      expect(chunk.start).toBe(expected);
      expected = chunk.end;
    }
    expect(expected).toBe(pts.length);
  });

  test("each chunk's AABB bounds every point it contains", () => {
    const pts = sCurveOutline(250, 1);
    const index = buildTrackIndex(pts, 64);

    for (const chunk of index.chunks) {
      for (let i = chunk.start; i < chunk.end; i++) {
        const p = pts[i];
        expect(p.x).toBeGreaterThanOrEqual(chunk.minX);
        expect(p.x).toBeLessThanOrEqual(chunk.maxX);
        expect(p.z).toBeGreaterThanOrEqual(chunk.minZ);
        expect(p.z).toBeLessThanOrEqual(chunk.maxZ);
      }
    }
  });
});
