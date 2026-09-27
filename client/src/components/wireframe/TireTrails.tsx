import { resolveWheelStates } from "../../../../shared/racing/analysis/metric-values";
import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import * as THREE from "three/webgpu";
import { semanticNumber, type SemanticAnalysisFrame } from "../analyse/track-map/types";
import type { CarModelEnrichment } from "../../data/car-models";
import { getWheelOffsets, resolveTrailLateralUtilization, trailColorFromState } from "../../lib/wireframe-utils";
import type { GameId } from "../../../../shared/games/ids";

const TRAIL_LENGTH_M_DEFAULT = 4;
const TRAIL_LENGTH_M_ACC = 2;
const MAX_TRAIL_SAMPLES = 64;
const MAX_TRAIL_INSTANCES = 256;
export type TireTrailResource = { mesh: THREE.InstancedMesh; dummy: THREE.Object3D; offsets: [number, number][] };
export function createTireTrailResource(scene: THREE.Scene, carModel: CarModelEnrichment): TireTrailResource {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial(), MAX_TRAIL_INSTANCES);
  mesh.setColorAt(0, trailColorFromState("nominal", 0, 0));
  mesh.count = 0; mesh.frustumCulled = false; scene.add(mesh);
  return { mesh, dummy: new THREE.Object3D(), offsets: getWheelOffsets(carModel) };
}
export function updateTireTrailResource(resource: TireTrailResource, telemetry: SemanticAnalysisFrame[], cursorIdx: number, gameId: GameId): void {
  const mesh = resource.mesh, frame = telemetry[cursorIdx];
  if (!frame) { mesh.count = 0; return; }
  const analysis = resolveAnalysisTelemetry(getGame(gameId));
  const trailLength = gameId === "acc" ? TRAIL_LENGTH_M_ACC : TRAIL_LENGTH_M_DEFAULT;
  let start = cursorIdx, distance = 0, lastLength = 0;
  while (start > 0 && cursorIdx - start < MAX_TRAIL_SAMPLES) {
    const a = telemetry[start], b = telemetry[start - 1];
    lastLength = Math.hypot((semanticNumber(a, "motion.position-x") ?? 0) - (semanticNumber(b, "motion.position-x") ?? 0), (semanticNumber(a, "motion.position-z") ?? 0) - (semanticNumber(b, "motion.position-z") ?? 0));
    distance += lastLength; start--; if (distance >= trailLength) break;
  }
  if (cursorIdx - start < 2) { mesh.count = 0; return; }
  const fraction = distance > trailLength && lastLength > 1e-6 ? (distance - trailLength) / lastLength : 0;
  const cx = semanticNumber(frame, "motion.position-x") ?? 0, cz = semanticNumber(frame, "motion.position-z") ?? 0;
  const s = Math.sin(semanticNumber(frame, "motion.yaw") ?? 0), c = Math.cos(semanticNumber(frame, "motion.yaw") ?? 0);
  let instance = 0;
  for (let wheel = 0; wheel < 4 && instance < MAX_TRAIL_INSTANCES; wheel++) {
    const off = resource.offsets[wheel];
    for (let i = start; i < cursorIdx && instance < MAX_TRAIL_INSTANCES; i++) {
      const a = telemetry[i], b = telemetry[i + 1];
      let ax = semanticNumber(a, "motion.position-x") ?? 0, az = semanticNumber(a, "motion.position-z") ?? 0;
      if (i === start && fraction > 0) { ax += ((semanticNumber(b, "motion.position-x") ?? 0) - ax) * fraction; az += ((semanticNumber(b, "motion.position-z") ?? 0) - az) * fraction; }
      const bx = semanticNumber(b, "motion.position-x") ?? 0, bz = semanticNumber(b, "motion.position-z") ?? 0;
      const x0 = (ax - cx) * s + (az - cz) * c + off[0], z0 = (ax - cx) * c - (az - cz) * s + off[1];
      const x1 = (bx - cx) * s + (bz - cz) * c + off[0], z1 = (bx - cx) * c - (bz - cz) * s + off[1];
      const dx = x1 - x0, dz = z1 - z0, length = Math.hypot(dx, dz); if (length < 0.001) continue;
      const state = resolveWheelStates(a, analysis.traction)[wheel];
      const slips = a.values["tires.tire-slip-ratio"];
      const slip = state?.slipRatio ?? (Array.isArray(slips) && typeof slips[wheel] === "number" ? slips[wheel] : 0);
      resource.dummy.position.set((x0 + x1) / 2, -0.42, (z0 + z1) / 2);
      resource.dummy.rotation.set(0, Math.atan2(dx, dz), 0); resource.dummy.scale.set(0.025, 0.01, length); resource.dummy.updateMatrix();
      mesh.setMatrixAt(instance, resource.dummy.matrix);
      mesh.setColorAt(instance, trailColorFromState(state?.state ?? "nominal", slip, resolveTrailLateralUtilization(a, wheel))); instance++;
    }
  }
  mesh.count = instance; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
export function disposeTireTrailResource(resource: TireTrailResource): void { resource.mesh.removeFromParent(); resource.mesh.dispose(); resource.mesh.geometry.dispose(); (resource.mesh.material as THREE.Material).dispose(); }
