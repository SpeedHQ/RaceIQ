import { expect, test } from "bun:test";
import type { Point, TrackMapBoundaries } from "../src/components/analyse/track-map/types";
import { alignTrackBoundariesToSession } from "../src/components/analyse/track-map/session-alignment";

const circuit = (): Point[] => Array.from({ length: 120 }, (_, i) => {
  const angle = i / 120 * Math.PI * 2;
  const radius = 260 + 25 * Math.sin(angle * 3) + 12 * Math.cos(angle * 5);
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.72 };
});

const boundaries = (centerLine: Point[]): TrackMapBoundaries => ({
  centerLine,
  leftEdge: centerLine.map(point => ({ x: point.x - 5, z: point.z })),
  rightEdge: centerLine.map(point => ({ x: point.x + 5, z: point.z })),
  pitLane: null,
  coordSystem: "lmu",
});

const translated = (points: Point[], x: number, z: number): Point[] => points.map(point => ({ x: point.x + x, z: point.z + z }));

test("partial lap cannot distort complete circuit geometry", () => {
  const line = circuit();
  const result = alignTrackBoundariesToSession(boundaries(line), [translated(line.slice(0, 12), 900, -700)]);
  expect(result).toEqual(boundaries(line));
});

test("stationary frames and teleport outlier do not bias full-lap registration", () => {
  const line = circuit();
  const replay = translated(line, 120, -80);
  const noisy = [replay[0], ...Array.from({ length: 500 }, () => replay[0]), ...replay.slice(1)];
  noisy.splice(60, 0, { x: 1_000_000, z: -1_000_000 });
  const result = alignTrackBoundariesToSession(boundaries(line), [noisy]);
  expect(result).not.toBeNull();
  expect(result!.centerLine.reduce((sum, point, i) => sum + Math.hypot(point.x - replay[i].x, point.z - replay[i].z), 0) / line.length).toBeLessThan(8);
});

test("partial lap contributes spatially without stationary frames dominating", () => {
  const line = circuit();
  const full = translated(line, 80, -40);
  const partial = translated(line.slice(20, 70), 100, -30);
  const repeated = [partial[0], ...Array.from({ length: 400 }, () => partial[0]), ...partial.slice(1)];
  const result = alignTrackBoundariesToSession(boundaries(line), [full, repeated]);
  expect(result).not.toBeNull();
  const shift = result!.centerLine.reduce((sum, point, i) => sum + point.x - line[i].x, 0) / line.length;
  expect(shift).toBeGreaterThan(80);
  expect(shift).toBeLessThan(100);
});

test("session result is stable under lap order and excludes scale outlier", () => {
  const line = circuit();
  const first = translated(line, 80, -40);
  const second = translated(line, 100, -30);
  const partial = translated(line.slice(20, 70), 90, -35);
  const outlier = line.map(point => ({ x: point.x * 1.8 + 50, z: point.z * 1.8 - 20 }));
  const base = boundaries(line);
  const forward = alignTrackBoundariesToSession(base, [first, second, partial, outlier]);
  const reverse = alignTrackBoundariesToSession(base, [outlier, partial, second, first]);
  expect(forward).toEqual(reverse);
  expect(forward).not.toBeNull();
  const meanX = forward!.centerLine.reduce((sum, point) => sum + point.x, 0) / line.length;
  expect(meanX).toBeGreaterThan(80);
  expect(meanX).toBeLessThan(100);
});

test("session registration preserves reflected and rotated coordinate frames", () => {
  const line = circuit();
  const rotation = 0.61;
  const positions = line.map(point => ({
    x: 1.02 * (-Math.cos(rotation) * point.x - Math.sin(rotation) * point.z) + 300,
    z: 1.02 * (-Math.sin(rotation) * point.x + Math.cos(rotation) * point.z) - 140,
  }));
  const result = alignTrackBoundariesToSession(boundaries(line), [positions, positions.slice(20, 70)]);
  const error = result!.centerLine.reduce((sum, point, index) =>
    sum + Math.hypot(point.x - positions[index].x, point.z - positions[index].z), 0) / line.length;
  expect(error).toBeLessThan(8);
});
