import * as THREE from "three/webgpu";
import { suspensionColor, threeColor, THREE_COLORS } from "../../lib/wireframe-utils";
import { createRibbonPool, disposeRibbonPool, updateRibbonPool, type RibbonPool } from "./LineResources";

export type SuspensionSpringResource = { spring: RibbonPool; rod: RibbonPool };
export function createSuspensionSpringResource(scene: THREE.Scene): SuspensionSpringResource {
  const spring = createRibbonPool({ depthTest: false }), rod = createRibbonPool({ depthTest: false });
  spring.group.renderOrder = 10; rod.group.renderOrder = 10; scene.add(spring.group, rod.group);
  return { spring, rod };
}
export function updateSuspensionSpringResource(resource: SuspensionSpringResource, camera: THREE.PerspectiveCamera, bodyPos: [number, number, number], wheelPos: [number, number, number], suspTravel: number, suspThresholds: number[], viewportHeight: number): void {
  const pts = [];
  const tint = threeColor(suspensionColor(suspTravel, suspThresholds));
  const coils = 6, segments = coils * 12, radius = 0.032;
  for (let i = 0; i <= segments; i++) { const t = i / segments, angle = t * coils * Math.PI * 2; pts.push({ x: bodyPos[0] + Math.cos(angle) * radius, y: wheelPos[1] + t * (bodyPos[1] - wheelPos[1]), z: bodyPos[2] + Math.sin(angle) * radius, color: tint, alpha: 1 }); }
  updateRibbonPool(resource.spring, camera, [pts], 4, viewportHeight);
  updateRibbonPool(resource.rod, camera, [[{ x: bodyPos[0], y: bodyPos[1] + 0.05, z: bodyPos[2], color: THREE_COLORS.appTextDim }, { x: bodyPos[0], y: wheelPos[1] - 0.05, z: bodyPos[2], color: THREE_COLORS.appTextDim }]], 1, viewportHeight);
}
export function disposeSuspensionSpringResource(resource: SuspensionSpringResource): void { disposeRibbonPool(resource.spring); disposeRibbonPool(resource.rod); resource.spring.group.removeFromParent(); resource.rod.group.removeFromParent(); }
