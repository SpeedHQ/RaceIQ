import type { FocusCenterPoint } from "../src/components/comparison/spectate/spectate-focus-lanes";
import * as THREE from "three";
import { expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import type { TrackMapBoundaries } from "../src/components/analyse/track-map/types";
import { SpectateSceneRuntime } from "../src/components/comparison/spectate/SpectateSceneRuntime";
import type { SpectatePair, SpectateSample } from "../src/components/comparison/spectate/types";
import type { RibbonRun } from "@raceiq/scene-3d/wireframe/LineResources";

initGameAdapters({ f1Experiments: true, iracingAdapter: true });

type Point = { x: number; z: number };
type GeometryProbe = Pick<SpectateSceneRuntime, "setOutline"> & {
  edgeRuns: RibbonRun[];
  lineRuns: [RibbonRun[], RibbonRun[]];
  projectedCenterlinePoints: [ (FocusCenterPoint | null)[], (FocusCenterPoint | null)[] ],
  focusLaneAvailable: boolean;
  schematicLinesActive: boolean;
  scene: THREE.Scene;
  racingLinePoints: THREE.InstancedMesh;
};
const center = Array.from({ length: 16 }, (_, i) => ({ x: 100 * Math.cos(i * Math.PI / 8), z: 70 * Math.sin(i * Math.PI / 8) }));
const leftEdge = center.map(p => ({ x: p.x - 5, z: p.z }));
const rightEdge = center.map(p => ({ x: p.x + 5, z: p.z }));
const origin = { x: 10, y: 4, z: 20 };

function geometry(gameId: string, points: Point[]): GeometryProbe {
  const samples: SpectateSample[] = points.map((p, i) => ({
    time: i * 0.05, distance: i, run: 0,
    values: { "motion.position-x": p.x, "motion.position-y": 4, "motion.position-z": p.z },
  }));
  // Exercise the production geometry builder without creating a GPU renderer.
  return Object.assign(Object.create(SpectateSceneRuntime.prototype) as GeometryProbe, {
    pair: { gameId, a: { samples }, b: { samples } },
    origin, canvas: { dataset: {} }, wake: () => {}, scene: new THREE.Scene(),
    racingLinePoints: new THREE.InstancedMesh(new THREE.CircleGeometry(1), new THREE.MeshBasicMaterial(), 1),
    edgeRuns: [], lineRuns: [[], []],
    projectedCenterlinePoints: [[], []],
    focusLaneAvailable: false, schematicLinesActive: false,
  });
}

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
      expect(runtime.edgeRuns.map(run => run.map(({ x, z }) => ({ x, z })))).toEqual([
        expected(leftEdge), expected(rightEdge), expected(leftEdge.slice(0, 3)), expected(rightEdge.slice(0, 3)),
      ]);
      expect(runtime.lineRuns[0][0][0]).toMatchObject({ x: driven[0].x - origin.x, z: driven[0].z - origin.z });
    });
  }
}

test("LMU preserves native outline coordinates when boundaries are absent", () => {
  const runtime = geometry("lmu", center.slice(0, 2).map(p => ({ x: p.x + 3, z: p.z })));
  runtime.setOutline(center, null);
  expect(runtime.edgeRuns[0].map(({ x, z }) => ({ x, z }))).toEqual(center.map(p => ({ x: p.x - origin.x, z: p.z - origin.z })));
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
