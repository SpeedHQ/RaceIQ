import { expect, test } from "bun:test";
import * as THREE from "three/webgpu";
import { createRibbonPool, disposeRibbonPool, updateRibbonPool } from "../src/components/wireframe/LineResources";

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
