import * as THREE from "three/webgpu";
import type { CarModelEnrichment } from "../model-types";
import { THREE_COLORS } from "../wireframe-utils";
import { createOpaqueWideLine, disposeOpaqueWideLine, updateOpaqueWideLine } from "./LineResources";

type Dimensions = Pick<CarModelEnrichment, "halfWheelbase" | "halfFrontTrack" | "halfRearTrack">;
export interface DrivetrainResource {
  root: THREE.Group;
  update(model: Dimensions): void;
  dispose(): void;
}

/** Original axle, differential and center-shaft geometry in wheel-local coordinates. */
export function createDrivetrainResource(): DrivetrainResource {
  const root = new THREE.Group();
  const axles = [
    createOpaqueWideLine(THREE_COLORS.appTextDim, 2),
    createOpaqueWideLine(THREE_COLORS.appTextDim, 2),
    createOpaqueWideLine(THREE_COLORS.wireframeStructure, 1.5),
  ];
  root.add(...axles);
  const geometry = new THREE.BoxGeometry(0.15, 0.12, 0.2);
  const material = new THREE.MeshBasicMaterial({ color: THREE_COLORS.appTextDim, wireframe: true });
  const front = new THREE.Mesh(geometry, material), rear = new THREE.Mesh(geometry, material);
  root.add(front, rear);
  const positions = Array.from({ length: 3 }, () => [new THREE.Vector3(), new THREE.Vector3()]);
  let wheelbase = Number.NaN, frontTrack = Number.NaN, rearTrack = Number.NaN;
  return {
    root,
    update(model) {
      const wb = model.halfWheelbase, ft = model.halfFrontTrack, rt = model.halfRearTrack;
      if (wb === wheelbase && ft === frontTrack && rt === rearTrack) return;
      positions[0]![0]!.set(wb, 0, -ft); positions[0]![1]!.set(wb, 0, ft);
      positions[1]![0]!.set(-wb, 0, -rt); positions[1]![1]!.set(-wb, 0, rt);
      positions[2]![0]!.set(wb, 0, 0); positions[2]![1]!.set(-wb, 0, 0);
      for (let index = 0; index < axles.length; index++) updateOpaqueWideLine(axles[index]!, positions[index]!);
      front.position.x = wb;
      rear.position.x = -wb;
      wheelbase = wb; frontTrack = ft; rearTrack = rt;
    },
    dispose() {
      for (const line of axles) disposeOpaqueWideLine(line);
      geometry.dispose();
      material.dispose();
      root.removeFromParent();
    },
  };
}
