import type { FocusCenterPoint } from "../../ui/spectate-focus-lanes";
import * as THREE from "three";
import { expect } from "bun:test";
import { SpectateSceneRuntime } from "../../ui/SpectateSceneRuntime";
import type { SpectateSample } from "../../contracts/spectate";
import type { RibbonRun } from "@raceiq/scene-3d/wireframe/LineResources";

export type Point = { x: number; z: number };
type GeometryProbe = Pick<SpectateSceneRuntime, "setOutline"> & {
  edgeRuns: RibbonRun[];
  lineRuns: [RibbonRun[], RibbonRun[]];
  projectedCenterlinePoints: [(FocusCenterPoint | null)[], (FocusCenterPoint | null)[]];
  focusLaneAvailable: boolean;
  schematicLinesActive: boolean;
  scene: THREE.Scene;
  racingLinePoints: THREE.InstancedMesh;
};
export const center = Array.from({ length: 16 }, (_, i) => ({ x: 100 * Math.cos(i * Math.PI / 8), z: 70 * Math.sin(i * Math.PI / 8) }));
export const leftEdge = center.map(p => ({ x: p.x - 5, z: p.z }));
export const rightEdge = center.map(p => ({ x: p.x + 5, z: p.z }));
export const origin = { x: 10, y: 4, z: 20 };

export function geometry(gameId: string, points: Point[]): GeometryProbe {
  const samples: SpectateSample[] = points.map((p, i) => ({
    time: i * 0.05, distance: i, run: 0,
    values: { "motion.position-x": p.x, "motion.position-y": 4, "motion.position-z": p.z },
  }));
  // Exercise the production geometry builder without creating a GPU renderer.
  return Object.assign(Object.create(SpectateSceneRuntime.prototype) as GeometryProbe, {
    pair: { gameId, a: { samples, replay: {} }, b: { samples, replay: {} }, comparison: { lapA: {}, lapB: {} } },
    origin, canvas: { dataset: {} }, wake: () => {}, scene: new THREE.Scene(),
    racingLinePoints: new THREE.InstancedMesh(new THREE.CircleGeometry(1), new THREE.MeshBasicMaterial(), 1),
    estimatedLines: [0, 1].map(() => new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial())),
    estimatedLineCounts: [0, 0],
    edgeRuns: [], lineRuns: [[], []],
    projectedCenterlinePoints: [[], []],
    focusLaneAvailable: false, schematicLinesActive: false,
  });
}
export function expectOnPaths(runs: RibbonRun[], paths: Point[][]): void {
  for (const path of paths) expect(runs.some(run => Math.hypot(run[0]!.x - path[0]!.x, run[0]!.z - path[0]!.z) < 1e-6)).toBe(true);
  for (const run of runs) for (const point of run) {
    const onPath = paths.some(path => path.slice(1).some((b, i) => {
      const a = path[i]!, dx = b.x - a.x, dz = b.z - a.z;
      const fraction = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(point.x - a.x - dx * fraction, point.z - a.z - dz * fraction) < 1e-6;
    }));
    expect(onPath).toBe(true);
  }
}
