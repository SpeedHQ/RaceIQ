import * as THREE from "three/webgpu";
import { semanticNumber, type SemanticAnalysisFrame } from "../analyse/track-map/types";
import { buildTrackIndex, filterByDistanceIndexed, threeColor, type TrackIndex } from "../../lib/wireframe-utils";
import { createRibbonPool, disposeRibbonPool, updateRibbonPool, type RibbonPool } from "./LineResources";

export type InputRun = { id: number; pts: [number, number, number][]; values: number[] };
export function buildInputOverlayRuns(telemetry: SemanticAnalysisFrame[], index: TrackIndex, packet: SemanticAnalysisFrame): { throttleRuns: InputRun[]; brakeRuns: InputRun[] } {
  const cx = semanticNumber(packet, "motion.position-x") ?? 0;
  const cz = semanticNumber(packet, "motion.position-z") ?? 0;
  const yaw = semanticNumber(packet, "motion.yaw") ?? 0;
  const segments = filterByDistanceIndexed(index, cx, cz, yaw, -0.44, 60, 20, 30);
  const throttleRuns: InputRun[] = [], brakeRuns: InputRun[] = [];
  for (const segment of segments) {
    const throttlePts: [number, number, number][] = [], throttleValues: number[] = [];
    const brakePts: [number, number, number][] = [], brakeValues: number[] = [];
    let throttleStart = -1, brakeStart = -1;
    const flush = (bucket: InputRun[], id: number, pts: [number, number, number][], values: number[]) => {
      if (pts.length >= 5) bucket.push({ id, pts: pts.slice(), values: values.slice() });
      pts.length = 0; values.length = 0;
    };
    for (let i = 0; i < segment.points.length; i++) {
      const sourceIndex = segment.sourceStartIndex + i;
      const frame = telemetry[sourceIndex];
      const point = segment.points[i];
      const throttle = semanticNumber(frame, "inputs.accel") ?? 0;
      const brake = (semanticNumber(frame, "inputs.brake") ?? 0) / 255;
      const prev = segment.points[Math.max(0, i - 1)], next = segment.points[Math.min(segment.points.length - 1, i + 1)];
      const df = next[0] - prev[0], dl = next[2] - prev[2], length = Math.hypot(df, dl) || 1;
      const nf = -dl / length, nl = df / length;
      if (throttle > 0.02) {
        if (!throttlePts.length) throttleStart = sourceIndex;
        throttlePts.push([point[0] + nf * 0.1, point[1], point[2] + nl * 0.1]); throttleValues.push(throttle);
      } else if (throttlePts.length) flush(throttleRuns, throttleStart, throttlePts, throttleValues);
      if (brake > 0.02) {
        if (!brakePts.length) brakeStart = sourceIndex;
        brakePts.push([point[0] - nf * 0.1, point[1], point[2] - nl * 0.1]); brakeValues.push(brake);
      } else if (brakePts.length) flush(brakeRuns, brakeStart, brakePts, brakeValues);
    }
    if (throttlePts.length) flush(throttleRuns, throttleStart, throttlePts, throttleValues);
    if (brakePts.length) flush(brakeRuns, brakeStart, brakePts, brakeValues);
  }
  return { throttleRuns, brakeRuns };
}

type InputRibbonPoint = { x: number; y: number; z: number; color: THREE.Color; alpha: number };
export type InputOverlayResource = {
  throttle: RibbonPool; brake: RibbonPool;
  throttleRuns: InputRibbonPoint[][]; brakeRuns: InputRibbonPoint[][];
  indexSource: { telemetry: SemanticAnalysisFrame[]; index: TrackIndex } | null;
};
export function createInputOverlayResource(scene: THREE.Scene): InputOverlayResource {
  const throttle = createRibbonPool({ opacity: 0.9 }); const brake = createRibbonPool({ opacity: 0.9 });
  scene.add(throttle.group, brake.group);
  return { throttle, brake, throttleRuns: [], brakeRuns: [], indexSource: null };
}
function fillRibbonRuns(items: InputRun[], target: InputRibbonPoint[][], inactive: THREE.Color, active: THREE.Color, scale: number): void {
  for (let runIndex = 0; runIndex < items.length; runIndex++) {
    const item = items[runIndex], points = target[runIndex] ?? (target[runIndex] = []);
    for (let i = 0; i < item.pts.length; i++) {
      const [x, y, z] = item.pts[i];
      const point = points[i] ?? (points[i] = { x: 0, y: 0, z: 0, color: new THREE.Color(), alpha: 0.9 });
      point.x = x; point.y = y; point.z = z;
      point.color.copy(inactive).lerp(active, item.values[i] * scale / 255);
    }
    points.length = item.pts.length;
  }
  target.length = items.length;
}
export function updateInputOverlayResource(resource: InputOverlayResource, camera: THREE.PerspectiveCamera, telemetry: SemanticAnalysisFrame[], packet: SemanticAnalysisFrame, viewportHeight: number): void {
  if (resource.indexSource?.telemetry !== telemetry) {
    const points = telemetry.map((frame) => ({ x: semanticNumber(frame, "motion.position-x") ?? 0, z: semanticNumber(frame, "motion.position-z") ?? 0 }));
    resource.indexSource = { telemetry, index: buildTrackIndex(points) };
  }
  const runs = buildInputOverlayRuns(telemetry, resource.indexSource.index, packet);
  const inactive = threeColor("var(--app-bg)"), throttleColor = threeColor("var(--ch-throttle)"), brakeColor = threeColor("var(--ch-brake)");
  fillRibbonRuns(runs.throttleRuns, resource.throttleRuns, inactive, throttleColor, 1);
  fillRibbonRuns(runs.brakeRuns, resource.brakeRuns, inactive, brakeColor, 255);
  updateRibbonPool(resource.throttle, camera, resource.throttleRuns, 6, viewportHeight);
  updateRibbonPool(resource.brake, camera, resource.brakeRuns, 6, viewportHeight);
}
export function disposeInputOverlayResource(resource: InputOverlayResource): void {
  disposeRibbonPool(resource.throttle); disposeRibbonPool(resource.brake);
  resource.throttle.group.removeFromParent(); resource.brake.group.removeFromParent();
}
