import * as THREE from "three/webgpu";
import { buildTrackIndex, filterByDistanceIndexed, THREE_COLORS, type TrackIndex } from "../../lib/wireframe-utils";
import type { SemanticAnalysisFrame } from "../analyse/track-map/types";
import { semanticNumber } from "../analyse/track-map/types";

type TrackPoint = { x: number; z: number };
type MarkerSet = { mesh: THREE.InstancedMesh; source: TrackPoint[] | null; index: TrackIndex | null; dummy: THREE.Object3D; geometry: THREE.BufferGeometry; material: THREE.MeshBasicMaterial };
export type CurbMarkerResource = { curb: MarkerSet; puddle: MarkerSet };
function createMarkerSet(scene: THREE.Scene, radius: number, color: THREE.ColorRepresentation, opacity: number): MarkerSet {
  const geometry = new THREE.SphereGeometry(radius, 6, 6);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
  const mesh = new THREE.InstancedMesh(geometry, material, 1);
  mesh.count = 0; scene.add(mesh);
  return { mesh, source: null, index: null, dummy: new THREE.Object3D(), geometry, material };
}
export function createCurbMarkerResource(scene: THREE.Scene): CurbMarkerResource {
  return { curb: createMarkerSet(scene, 0.02, THREE_COLORS.surfaceContact, 0.9), puddle: createMarkerSet(scene, 0.1, THREE_COLORS.surfaceWet, 0.5) };
}
function updateSet(set: MarkerSet, points: TrackPoint[], packet: SemanticAnalysisFrame, y: number): void {
  if (set.source !== points) { set.source = points; set.index = buildTrackIndex(points); }
  const segments = filterByDistanceIndexed(set.index!, semanticNumber(packet, "motion.position-x") ?? 0, semanticNumber(packet, "motion.position-z") ?? 0, semanticNumber(packet, "motion.yaw") ?? 0, y);
  const wanted = segments.reduce((total, segment) => total + segment.points.length, 0);
  if (wanted > set.mesh.instanceMatrix.count) {
    const parent = set.mesh.parent;
    const capacity = Math.max(wanted, set.mesh.instanceMatrix.count * 2);
    const replacement = new THREE.InstancedMesh(set.geometry, set.material, capacity);
    replacement.frustumCulled = false;
    set.mesh.removeFromParent();
    set.mesh.dispose();
    set.mesh = replacement;
    parent?.add(replacement);
  }
  let count = 0;
  for (const segment of segments) for (const [x, py, z] of segment.points) {
    set.dummy.position.set(x, py, z); set.dummy.updateMatrix(); set.mesh.setMatrixAt(count++, set.dummy.matrix);
  }
  set.mesh.count = count; set.mesh.instanceMatrix.needsUpdate = true;
}
/** World-space marker point lists are identity-cached and filtered by indexed track chunks each pose. */
export function updateCurbMarkerResource(resource: CurbMarkerResource, curbPoints: TrackPoint[], puddlePoints: TrackPoint[], packet: SemanticAnalysisFrame, groundY: number): void {
  updateSet(resource.curb, curbPoints, packet, groundY); updateSet(resource.puddle, puddlePoints, packet, groundY);
}
export function disposeCurbMarkerResource(resource: CurbMarkerResource): void {
  for (const set of [resource.curb, resource.puddle]) { set.mesh.removeFromParent(); set.mesh.dispose(); set.geometry.dispose(); set.material.dispose(); }
}
