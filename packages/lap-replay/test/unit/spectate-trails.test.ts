import { expect, test } from "bun:test";
import * as THREE from "three";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { disposeTireTrailResource, type TireTrailResource } from "@raceiq/scene-3d/wireframe/TireTrails";
import { SpectateSceneRuntime } from "../../ui/SpectateSceneRuntime"
import type { SpectateReading, SpectateSample } from "../../contracts/spectate"

initGameAdapters({ f1Experiments: true, iracingAdapter: true });

type TrailProbe = { updateTrail(side: 0 | 1, reading: SpectateReading | null): void; trails: [TireTrailResource | null, TireTrailResource | null] };
const sample = (time: number, x: number, run = 0): SpectateSample => ({ time, distance: x, run, values: {
  "motion.position-x": x, "motion.position-y": 0, "motion.position-z": 0, "motion.yaw": Math.PI / 2,
} });
function probe(samples: SpectateSample[], motionSamples?: SpectateSample[]): TrailProbe {
  return Object.assign(Object.create(SpectateSceneRuntime.prototype) as TrailProbe, {
    scene: new THREE.Scene(), origin: new THREE.Vector3(), tireTrails: true,
    trails: [null, null], trailFrames: [[], []],
    pair: { gameId: "f1-2025", a: { samples, motionSamples }, b: { samples, motionSamples } },
    slots: [{ config: { carModel: { halfWheelbase: 1.5, halfFrontTrack: 0.8, halfRearTrack: 0.8 } } }],
    trailHeads: [{ values: {}, states: {}, freshness: {} }, { values: {}, states: {}, freshness: {} }],
  });
}
function draw(runtime: TrailProbe, time: number, x: number) {
  runtime.updateTrail(0, { time, distance: x, pose: { x, y: 0, z: 0, yaw: Math.PI / 2 }, values: sample(time, x).values });
  const mesh = runtime.trails[0]!.mesh;
  mesh.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  let head = -Infinity;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    for (const end of [-0.5, 0.5]) {
      head = Math.max(head, new THREE.Vector3(0, 0, end).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).x);
    }
  }
  return { head, mesh };
}

test("Spectate tire trails follow interpolated wheels between recorded ticks", () => {
  const samples = [sample(0, 0), sample(0.1, 1), sample(0.2, 2), sample(0.3, 3), sample(0.4, 4)];
  const runtime = probe(samples);
  try {
    for (const time of [0.21, 0.24, 0.29, 0.3, 0.31, 0.35, 0.4, 0.25]) {
      const { head, mesh } = draw(runtime, time, time * 10);
      expect(mesh.visible).toBe(true);
      expect(head).toBeCloseTo(time * 10 + 1.5, 5);
    }
    expect(samples.map(frame => frame.values["motion.position-x"])).toEqual([0, 1, 2, 3, 4]);
  } finally { for (const trail of runtime.trails) if (trail) disposeTireTrailResource(trail); }
});

test("Spectate trails use distinct F1 motion history without bridging new runs", () => {
  const motion = [sample(0, 0), sample(0.1, 1), sample(0.3, 3), sample(1.3, 13, 1), sample(1.4, 14, 1)];
  const runtime = probe([motion[0]!, motion[1]!, sample(0.2, 1), ...motion.slice(2)], motion);
  try {
    const { head } = draw(runtime, 0.25, 2.5);
    expect(head).toBeCloseTo(4, 5);
    expect(draw(runtime, 1.3, 13).mesh.visible).toBe(false);
    expect(draw(runtime, 0.5, 5).mesh.visible).toBe(false);
    runtime.updateTrail(0, null);
    expect(runtime.trails[0]!.mesh.visible).toBe(false);
  } finally { for (const trail of runtime.trails) if (trail) disposeTireTrailResource(trail); }
});
