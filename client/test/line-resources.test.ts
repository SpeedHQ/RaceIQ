import { expect, test } from "bun:test";
import * as THREE from "three/webgpu";
import { createRetainedGrid, createRibbonPool, disposeRibbonPool, updateRibbonPool } from "../src/components/wireframe/LineResources";
import { buildTrackIndex, filterByDistanceIndexed } from "../src/lib/wireframe-utils";

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);
const points = (count: number) => Array.from({ length: count }, (_, i) => ({ x: (i - count / 2) * 0.05, y: 0, z: 0, color: 0x00ff00, alpha: 0.4 }));

test("paired ribbons grow without retaining replaced index geometry, then shrink and hide", () => {
  const first = createRibbonPool(), second = createRibbonPool();
  updateRibbonPool(first, camera, [points(3)], 4, 240);
  updateRibbonPool(second, camera, [points(3)], 4, 240);
  const oldFirst = first.slots[0]!.geometry;
  const oldSecond = second.slots[0]!.geometry;
  updateRibbonPool(first, camera, [points(40)], 4, 240);
  updateRibbonPool(second, camera, [points(40)], 4, 240);
  expect(first.slots[0]!.geometry).not.toBe(oldFirst);
  expect(second.slots[0]!.geometry).not.toBe(oldSecond);
  expect(first.slots[0]!.geometry.index?.count).toBeGreaterThan(first.slots[0]!.geometry.drawRange.count);
  const grown = first.slots[0]!.geometry;
  updateRibbonPool(first, camera, [points(2)], 4, 240);
  expect(first.slots[0]!.geometry).toBe(grown);
  expect(grown.drawRange.count).toBe(54);
  updateRibbonPool(first, camera, [], 4, 240);
  expect(first.slots[0]!.mesh.visible).toBe(false);
  expect(grown.drawRange.count).toBe(0);
  disposeRibbonPool(first); disposeRibbonPool(second);
});

test("near-plane crossing clips ribbon rather than joining behind-camera segments", () => {
  const pool = createRibbonPool();
  updateRibbonPool(pool, camera, [[
    { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 6 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 },
  ]], 4, 240);
  expect(pool.slots.filter((slot) => slot.mesh.visible)).toHaveLength(2);
  expect(pool.slots.every((slot) => slot.geometry.drawRange.count > 0)).toBe(true);
  disposeRibbonPool(pool);
});

test("grid major and minor lines never overlap and cover fade radius throughout phase shift", () => {
  const grid = createRetainedGrid();
  const segments = (geometry: THREE.BufferGeometry) => {
    const positions = geometry.getAttribute("position");
    return Array.from({ length: positions.count / 2 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => positions.getComponent(i * 2 + Math.floor(j / 3), j % 3)).join(","));
  };
  const minor = new Set(segments(grid.minor.geometry));
  for (const segment of segments(grid.major.geometry)) expect(minor.has(segment)).toBe(false);
  const verticalLines = [grid.minor, grid.major].flatMap((line) => {
    const attr = line.geometry.getAttribute("position");
    return Array.from({ length: attr.count / 4 }, (_, i) => attr.getX(i * 4));
  });
  for (let metre = -8; metre <= 8; metre++) expect(verticalLines).toContain(metre);
  grid.updatePose(10_001.99, 5_001.99, Math.PI / 4);
  const center = grid.group.position.clone().negate().applyEuler(new THREE.Euler(0, -grid.group.rotation.y, 0));
  expect(12 - Math.abs(center.x)).toBeGreaterThan(8);
  expect(12 - Math.abs(center.z)).toBeGreaterThan(8);
  grid.dispose();
});

test("grid anchor follows track-relative coordinates through turns and seeks", () => {
  const grid = createRetainedGrid();
  const anchor = { x: 10_000, z: 5_000 };
  const track = buildTrackIndex([anchor, { x: 10_000, z: 5_001 }]);
  const check = (x: number, z: number, yaw: number) => {
    grid.updatePose(x, z, yaw);
    const point = filterByDistanceIndexed(track, x, z, yaw, -0.45)[0]!.points[0]!;
    expect(grid.group.position.x).toBeCloseTo(point[0]);
    expect(grid.group.position.z).toBeCloseTo(point[2]);
    expect(grid.group.rotation.y).toBeCloseTo(yaw);
  };
  check(10_000.2, 5_000.3, 0);
  check(10_000.2, 5_000.3, Math.PI / 4);
  check(10_000.6, 5_000.3, Math.PI / 4);
  grid.resetPose();
  check(10_000.2, 5_000.3, Math.PI / 2);
  grid.dispose();
});
