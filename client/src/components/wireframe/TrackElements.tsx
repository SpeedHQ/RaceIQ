import * as THREE from "three/webgpu";
import type { ScenePose } from "./ScenePlacement";
import { buildTrackIndex, createWallGeometry, DIST_AHEAD, filterByDistanceIndexed, THREE_COLORS, updateWallGeometry, type TrackIndex } from "../../lib/wireframe-utils";
import { createRibbonPool, disposeRibbonPool, updateRibbonPool, type RibbonPool } from "./LineResources";

type TrackPoint = { x: number; z: number; y?: number };
export type TrackLineResource = { pool: RibbonPool; indexSource: TrackPoint[] | null; index: TrackIndex | null; color: THREE.ColorRepresentation; width: number; opacity: number; y: number };
export function createTrackLineResource(scene: THREE.Scene, color: THREE.ColorRepresentation = THREE_COLORS.appText, width = 3, opacity = 0.6, y = -0.44): TrackLineResource {
  const pool = createRibbonPool({ opacity }); scene.add(pool.group);
  return { pool, indexSource: null, index: null, color, width, opacity, y };
}
export function updateTrackLineResource(resource: TrackLineResource, camera: THREE.PerspectiveCamera, points: TrackPoint[], pose: ScenePose, viewportHeight: number, distAhead = DIST_AHEAD): void {
  if (resource.indexSource !== points) { resource.indexSource = points; resource.index = buildTrackIndex(points); }
  const segments = filterByDistanceIndexed(resource.index!, pose.x, pose.z, pose.yaw, resource.y, distAhead, undefined, undefined, pose.y ?? 0);
  updateRibbonPool(resource.pool, camera, segments.map(({ points: pts }) => pts.map(([x, y, z]) => ({ x, y, z, color: resource.color, alpha: resource.opacity }))), resource.width, viewportHeight);
}
export function disposeTrackLineResource(resource: TrackLineResource): void { disposeRibbonPool(resource.pool); resource.pool.group.removeFromParent(); }

export type TrackBoundaryResource = { left: THREE.Mesh; right: THREE.Mesh; leftGeometry: THREE.BufferGeometry; rightGeometry: THREE.BufferGeometry; leftIndexSource: TrackPoint[] | null; rightIndexSource: TrackPoint[] | null; leftIndex: TrackIndex | null; rightIndex: TrackIndex | null };
export function createTrackBoundaryResource(scene: THREE.Scene): TrackBoundaryResource {
  const leftGeometry = createWallGeometry(), rightGeometry = createWallGeometry();
  const left = new THREE.Mesh(leftGeometry, new THREE.MeshBasicMaterial({ color: THREE_COLORS.trackCurbLeft, opacity: 0.5, transparent: true, side: THREE.DoubleSide }));
  const right = new THREE.Mesh(rightGeometry, new THREE.MeshBasicMaterial({ color: THREE_COLORS.trackCurbRight, opacity: 0.5, transparent: true, side: THREE.DoubleSide }));
  scene.add(left, right);
  return { left, right, leftGeometry, rightGeometry, leftIndexSource: null, rightIndexSource: null, leftIndex: null, rightIndex: null };
}
export function updateTrackBoundaryResource(resource: TrackBoundaryResource, boundaries: { leftEdge: TrackPoint[]; rightEdge: TrackPoint[] }, pose: ScenePose, tireRadius: number, distAhead = DIST_AHEAD): void {
  if (resource.leftIndexSource !== boundaries.leftEdge) { resource.leftIndexSource = boundaries.leftEdge; resource.leftIndex = buildTrackIndex(boundaries.leftEdge); }
  if (resource.rightIndexSource !== boundaries.rightEdge) { resource.rightIndexSource = boundaries.rightEdge; resource.rightIndex = buildTrackIndex(boundaries.rightEdge); }
  const cx = pose.x, cz = pose.z, yaw = pose.yaw;
  updateWallGeometry(resource.leftGeometry, filterByDistanceIndexed(resource.leftIndex!, cx, cz, yaw, -tireRadius, distAhead), 0.12);
  updateWallGeometry(resource.rightGeometry, filterByDistanceIndexed(resource.rightIndex!, cx, cz, yaw, -tireRadius, distAhead), 0.12);
}
export function disposeTrackBoundaryResource(resource: TrackBoundaryResource): void {
  resource.left.removeFromParent(); resource.right.removeFromParent();
  resource.leftGeometry.dispose(); resource.rightGeometry.dispose();
  (resource.left.material as THREE.Material).dispose(); (resource.right.material as THREE.Material).dispose();
}
