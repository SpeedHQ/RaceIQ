import * as THREE from "three";
import { expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import type { TrackMapBoundaries } from "../../contracts/host"
import type { SpectatePair } from "../../contracts/spectate"
import { createRibbonPool, updateRibbonPool, disposeRibbonPool, type RibbonRun } from "@raceiq/scene-3d/wireframe/LineResources";
import { center, leftEdge, rightEdge, origin, geometry, expectOnPaths, type Point } from "../support/spectate-track-geometry";

initGameAdapters({ f1Experiments: true, iracingAdapter: true });


test("track dashes retain 6/1 metre alpha masking across uneven samples, duplicates and corners", () => {
  const runtime = geometry("lmu", center);
  const edge = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 16 }];
  runtime.setOutline(null, { leftEdge: edge, rightEdge: [], centerLine: [], pitLane: null, coordSystem: "lmu" });
  expect(runtime.edgeRuns).toHaveLength(1);
  expect(runtime.edgeRuns[0]!.map(p => [p.x + origin.x, p.z + origin.z, p.alpha])).toEqual([
    [0, 0, 1], [2, 0, 1], [4, 0, 1], [4, 2, 1], [4, 2, 0],
    [4, 3, 0], [4, 3, 1], [4, 9, 1], [4, 9, 0], [4, 10, 0],
    [4, 10, 1], [4, 16, 1],
  ]);
  const long = geometry("lmu", center);
  long.setOutline(null, {
    leftEdge: Array.from({ length: 5001 }, (_, x) => ({ x, z: 0 })),
    rightEdge: [], centerLine: [], pitLane: null, coordSystem: "lmu",
  });
  // Unit rendering has no DOM to resolve the scene's CSS color tokens.
  for (const run of long.edgeRuns) for (const point of run) point.color = 0xffffff;
  const pool = createRibbonPool();
  updateRibbonPool(pool, new THREE.PerspectiveCamera(), long.edgeRuns, 2, 800);
  expect(long.edgeRuns).toHaveLength(1);
  expect(pool.slots).toHaveLength(1);
  disposeRibbonPool(pool);
});
test("ribbon alpha breaks share identical corner cross-sections without connector geometry", () => {
  const pool = createRibbonPool();
  const color = new THREE.Color("white");
  const run: RibbonRun = [
    { x: 0, y: 0, z: -10, color, alpha: 1 },
    { x: 1, y: 0, z: -10, color, alpha: 1 },
    { x: 1, y: 0, z: -10, color, alpha: 0 },
    { x: 2, y: 1, z: -10, color, alpha: 0 },
  ];
  updateRibbonPool(pool, new THREE.PerspectiveCamera(), [run], 4, 800);
  expect(pool.material.vertexColors).toBe(true);
  expect(pool.material.transparent).toBe(true);
  const slot = pool.slots[0]!;
  expect(Array.from(slot.positions.slice(6, 12))).toEqual(Array.from(slot.positions.slice(12, 18)));
  expect(slot.colors[11]).toBe(1);
  expect(slot.colors[15]).toBe(1);
  expect(slot.colors[19]).toBe(0);
  expect(slot.colors[23]).toBe(0);
  disposeRibbonPool(pool);
});

test("near-plane crossings retain CPU clipping and use visible-span meshes", () => {
  const pool = createRibbonPool();
  const color = new THREE.Color("white");
  const run: RibbonRun = [
    { x: 0, y: 0, z: -1, color },
    { x: 1, y: 0, z: 1, color },
    { x: 2, y: 0, z: -1, color },
  ];
  updateRibbonPool(pool, new THREE.PerspectiveCamera(), [run], 4, 800);
  expect(pool.slots).toHaveLength(2);
  expect(pool.slots.every((slot) => slot.mesh.visible)).toBe(true);
  disposeRibbonPool(pool);
});

const cases = [
  ["fm-2023", "forza", false],
  ["f1-2025", "f1-2025", false],
  ["acc", "acc", true],
  ["ac-evo", "acc", true],
  ["lmu", "lmu", false],
] as const;

for (const [gameId, coordSystem, flip] of cases) {
  for (const partial of [false, true]) {
    test(`${gameId} preserves world boundaries for ${partial ? "partial" : "off-center"} laps`, () => {
      // A tighter, shifted racing line must never shrink or reposition the circuit.
      const driven = center.map(p => ({ x: (flip ? -p.x : p.x) * 0.9 + 3, z: p.z * 0.9 }));
      const runtime = geometry(gameId, partial ? driven.slice(0, 2) : driven);
      const boundaries: TrackMapBoundaries = {
        leftEdge, rightEdge, centerLine: partial ? [] : center,
        pitLane: null, raceLine: null, coordSystem,
        additionalSections: [{ leftEdge: leftEdge.slice(0, 3), rightEdge: rightEdge.slice(0, 3) }],
      };
      runtime.setOutline(null, boundaries);
      const expected = (points: Point[]) => points.map(p => ({ x: (flip ? -p.x : p.x) - origin.x, z: p.z - origin.z }));
      expectOnPaths(runtime.edgeRuns, [
        expected(leftEdge), expected(rightEdge), expected(leftEdge.slice(0, 3)), expected(rightEdge.slice(0, 3)),
      ]);
      expect(runtime.lineRuns[0][0][0]).toMatchObject({ x: driven[0].x - origin.x, z: driven[0].z - origin.z });
    });
  }
}



test("fallback outline stays solid while recorded car lines retain true run gaps", () => {
  const runtime = geometry("lmu", center);
  const pair = Reflect.get(runtime, "pair") as SpectatePair;
  const samples = pair.a.samples.map((sample, i) => ({
    ...sample,
    time: i === 2 ? 1 : i * 0.05,
    run: i < 2 ? 0 : 1,
  }));
  Object.assign(pair.a, { samples });
  runtime.setOutline(center, null);
  expect(runtime.edgeRuns).toHaveLength(1);
  expect(runtime.edgeRuns[0]!.every(point => point.alpha === 1)).toBe(true);
  expect(runtime.lineRuns[0]).toHaveLength(2);
});
test("unregistered geometry retains validated coordinate fitting", () => {
  const runtime = geometry("fm-2023", center.map(p => ({ x: p.x + 3, z: p.z })));
  const raw = (points: Point[]) => points.map(p => ({ x: p.x * 10, z: p.z * 10 }));
  runtime.setOutline(null, { leftEdge: raw(leftEdge), rightEdge: raw(rightEdge), centerLine: raw(center), pitLane: null, raceLine: null, coordSystem: "tumftm" });
  expect(runtime.edgeRuns[0][0].x).toBeCloseTo(leftEdge[0].x + 3 - origin.x, 6);
  expect(runtime.edgeRuns[0][0].z).toBeCloseTo(leftEdge[0].z - origin.z, 6);
});

test("schematic F1 geometry interpolates held moving packets without freezing badges", () => {
  const positions = [0, 2, 2, 6, 8];
  const runtime = geometry("f1-2025", positions.map(z => ({ x: 0, z })));
  const pair = Reflect.get(runtime, "pair") as SpectatePair;
  const samples = pair.a.samples.map((sample, i) => ({
    ...sample, time: i * 0.02, distance: i * 2,
    values: { ...sample.values, "motion.yaw": 0, "motion.speed": 100 },
  }));
  for (const lap of [pair.a, pair.b]) Object.assign(lap, { samples, motionSamples: samples.filter((_, i) => i !== 2) });
  runtime.setOutline(null, {
    coordSystem: "f1-2025", centerLine: [0, 2, 4, 6, 8].map(z => ({ x: 0, z })),
    leftEdge: [{ x: -5, z: 0 }, { x: -5, z: 8 }], rightEdge: [{ x: 5, z: 0 }, { x: 5, z: 8 }],
    pitLane: null,
  });
  const sources = Reflect.get(runtime, "projectedLaneSources") as { z: number }[][][];
  expect(sources[0][0].map(p => p.z + origin.z)).toEqual([0, 2, 4, 6, 8]);
  expect(runtime.lineRuns[0][0].map(p => p.z + origin.z)).toEqual(positions);
});
