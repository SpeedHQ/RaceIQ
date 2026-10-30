import { expect, test } from "bun:test";
import * as THREE from "three/webgpu";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { SceneOverlays } from "../src/components/wireframe/SceneOverlays";
import type { SceneRuntimeConfig } from "../src/components/wireframe/SceneRuntime";
import { DEFAULT_TOGGLES } from "../src/lib/wireframe-data";

initGameAdapters({ f1Experiments: false, iracingAdapter: true });

const sample = { values: { "suspension.norm-suspension-travel": [0.5, 0.5, 0.5, 0.5] }, states: {}, freshness: {} };
const leftEdge = Array.from({ length: 61 }, (_, index) => ({ x: 95, z: 80 + index }));
const rightEdge = leftEdge.map(({ z }) => ({ x: 105, z }));
const config: SceneRuntimeConfig = {
  gameId: "iracing", frame: sample, telemetry: [sample], cursorIdx: 0, outline: null,
  poses: [{ x: 100, z: 100, yaw: 0, source: "lap-fraction" }],
  boundaries: { leftEdge, rightEdge }, boundarySpace: "lap-fraction",
  toggles: { ...DEFAULT_TOGGLES, track: true, grid: false, inputs: false, trails: false, wheelInfo: false, springs: false, drivetrain: false, dimensions: false },
  viewPreset: "3/4", carModel: { modelPath: "", halfWheelbase: 1.35, halfFrontTrack: 0.93, halfRearTrack: 0.91, bodyLength: 4.5, tireRadius: 0.33, hasModel: false },
  modelOffsetX: 0, hideModelWheels: false, autoOrbit: false, fpsCap: 60, fmtTemp: String,
  suspThresholds: [25, 65, 85], temperatureThresholds: { cold: 70, warm: 100, hot: 120 }, temperatureSemanticId: "tire.temperature.carcass.middle",
};

function renderedWalls(scene: THREE.Scene): THREE.Mesh[] {
  return scene.children.filter((object): object is THREE.Mesh => object instanceof THREE.Mesh && object.visible && Number.isFinite(object.geometry.drawRange.count) && object.geometry.drawRange.count > 0);
}

test("draws both iRacing edges around a derived pose without native position telemetry", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const overlays = new SceneOverlays(scene, camera);
  try {
    overlays.update(sample, [sample], 0, config, null, 0, 0, 0, 600);
    const walls = renderedWalls(scene);
    expect(walls).toHaveLength(2);
    const sides = walls.map((wall) => {
      const index = wall.geometry.index!;
      const positions = wall.geometry.getAttribute("position");
      const used = new Set(Array.from(index.array).slice(0, wall.geometry.drawRange.count));
      for (const vertex of used) {
        expect(Number.isFinite(positions.getX(vertex))).toBe(true);
        expect(Number.isFinite(positions.getY(vertex))).toBe(true);
        expect(Number.isFinite(positions.getZ(vertex))).toBe(true);
      }
      return positions.getZ(index.getX(0));
    });
    expect(sides.sort((a, b) => a - b)).toEqual([-5, 5]);
    overlays.update(sample, [sample], 0, { ...config, boundarySpace: "native" }, null, 1, 0, 0, 600);
    expect(renderedWalls(scene)).toEqual([]);
    overlays.update(sample, [sample], 0, { ...config, poses: [null] }, null, 2, 0, 0, 600);
    expect(renderedWalls(scene)).toEqual([]);
  } finally { overlays.dispose(); }
});

test("keeps AC EVO native positioning and boundary rendering", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const overlays = new SceneOverlays(scene, camera);
  try {
    overlays.update(sample, [sample], 0, { ...config, gameId: "ac-evo", boundarySpace: "native", poses: [{ x: 100, z: 100, yaw: 0, source: "native" }] }, null, 0, 0, 0, 600);
    expect(renderedWalls(scene)).toHaveLength(2);
  } finally { overlays.dispose(); }
});
