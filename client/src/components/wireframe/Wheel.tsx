import * as THREE from "three/webgpu";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { brakeTempColor, tireTempColor } from "../../lib/vehicle-dynamics";
import { makeWheelGeometries, threeColor, THREE_COLORS } from "../../lib/wireframe-utils";

export type WheelGeometries = {
  tire: THREE.BufferGeometry;
  surfaceBands: THREE.BufferGeometry[];
  carcass: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
};
export type WheelResource = {
  root: THREE.Group;
  pivot: THREE.Group;
  spin: THREE.Group;
  geometries: WheelGeometries;
  meshes: THREE.Mesh[];
  materials: THREE.MeshBasicMaterial[];
  curb: THREE.Mesh;
  puddle: THREE.Mesh;
};
export type WheelResourceConfig = {
  position: [number, number, number]; steerAngle: number; camberAngle?: number; rimColor: string;
  temperatureReadings: TireTemperatureReading[]; temperatureThresholds: { cold: number; warm: number; hot: number };
  brakeTemp: number; side: "left" | "right"; isRear: boolean; onCurb: boolean; puddleDepth: number;
  tireRadius?: number; tireWidth?: number;
};

/** Allocates retained wheel meshes. Call disposeWheelResource when wheel size changes or scene is disposed. */
export function createWheelResource(tireRadius = 0.34, tireWidth = 0.3): WheelResource {
  const geometries = makeWheelGeometries(tireRadius, tireWidth);
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  const camber = new THREE.Group();
  const spin = new THREE.Group();
  root.add(pivot); pivot.add(camber); camber.add(spin);
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.MeshBasicMaterial[] = [];
  const mesh = (geometry: THREE.BufferGeometry, options: THREE.MeshBasicMaterialParameters, order = 10) => {
    const material = new THREE.MeshBasicMaterial(options);
    const object = new THREE.Mesh(geometry, material); object.renderOrder = order; spin.add(object);
    meshes.push(object); materials.push(material); return object;
  };
  mesh(geometries.tire, { color: THREE_COLORS.appTextDim, wireframe: true, transparent: true, depthTest: false });
  mesh(geometries.rim, { color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false });
  for (const geometry of geometries.surfaceBands) mesh(geometry, { color: THREE_COLORS.appTextDim, wireframe: true, transparent: true, depthTest: false });
  mesh(geometries.carcass, { color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55, depthTest: false }, 9);
  mesh(geometries.core, { color: 0xffffff, wireframe: true, transparent: true, opacity: 0.75, depthTest: false }, 8);
  const brakeGeometry = new THREE.CylinderGeometry(tireRadius * 0.5, tireRadius * 0.5, 0.02, 24);
  const brake = mesh(brakeGeometry, { color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthTest: false });
  brake.rotation.x = Math.PI / 2; brake.position.z = (tireWidth * 0.6) * (root.position.x < 0 ? -1 : 1);
  const curbGeometry = new THREE.RingGeometry(tireRadius + 0.02, tireRadius + 0.1, 16);
  const curbMaterial = new THREE.MeshBasicMaterial({ color: THREE_COLORS.surfaceContact, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
  const curb = new THREE.Mesh(curbGeometry, curbMaterial); curb.rotation.x = Math.PI / 2; curb.position.y = -tireRadius; root.add(curb);
  const puddleGeometry = new THREE.CircleGeometry(tireRadius + 0.04, 16);
  const puddleMaterial = new THREE.MeshBasicMaterial({ color: THREE_COLORS.surfaceWet, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
  const puddle = new THREE.Mesh(puddleGeometry, puddleMaterial); puddle.rotation.x = Math.PI / 2; puddle.position.y = -tireRadius; root.add(puddle);
  meshes.push(curb, puddle);
  materials.push(curbMaterial, puddleMaterial);
  return { root, pivot, spin, geometries, meshes, materials, curb, puddle };
}

/** Updates transforms/materials without replacing meshes or GPU buffers. */
export function updateWheelResource(resource: WheelResource, config: WheelResourceConfig): void {
  const radius = config.tireRadius ?? 0.34;
  resource.root.position.set(...config.position);
  resource.pivot.rotation.y = config.steerAngle;
  resource.pivot.rotation.x = config.camberAngle ?? 0;
  resource.curb.visible = config.onCurb;
  resource.puddle.visible = config.puddleDepth > 0;
  resource.puddle.scale.setScalar(config.puddleDepth > 0 ? (radius + 0.04 + config.puddleDepth * 0.15) / (radius + 0.04) : 1);
  (resource.puddle.material as THREE.MeshBasicMaterial).opacity = 0.3 + config.puddleDepth * 0.4;
  let surface: number | null = null, carcass: number | null = null, core: number | null = null, profileCount = 0, profileMask = 0;
  for (const reading of config.temperatureReadings) {
    if (reading.kind === "surface") surface = reading.value;
    else if (reading.kind === "carcass") carcass = reading.value;
    else if (reading.kind === "core") core = reading.value;
    else if (reading.kind === "inner") { profileCount++; profileMask |= 1; }
    else if (reading.kind === "middle") { profileCount++; profileMask |= 2; }
    else if (reading.kind === "outer") { profileCount++; profileMask |= 4; }
  }
  const fallback = surface == null ? threeColor("var(--status-unavailable)") : threeColor(tireTempColor(surface, config.temperatureThresholds));
  resource.meshes[0].visible = profileCount === 0;
  (resource.meshes[0].material as THREE.MeshBasicMaterial).color.copy(fallback);
  for (const reading of config.temperatureReadings) {
    let bandIndex = -1;
    if (reading.kind === "inner") bandIndex = 0;
    else if (reading.kind === "middle") bandIndex = 1;
    else if (reading.kind === "outer") bandIndex = 2;
    if (bandIndex < 0) continue;
    const band = resource.meshes[2 + bandIndex];
    band.visible = true;
    (band.material as THREE.MeshBasicMaterial).color.copy(reading.value == null ? THREE_COLORS.appTextDim : threeColor(tireTempColor(reading.value, config.temperatureThresholds)));
  }
  for (let i = 0; i < resource.geometries.surfaceBands.length; i++) resource.meshes[2 + i].visible = (profileMask & (1 << i)) !== 0;
  const carcassMesh = resource.meshes[2 + resource.geometries.surfaceBands.length];
  const coreMesh = resource.meshes[3 + resource.geometries.surfaceBands.length];
  carcassMesh.visible = carcass != null; coreMesh.visible = core != null;
  if (carcass != null) (carcassMesh.material as THREE.MeshBasicMaterial).color.copy(threeColor(tireTempColor(carcass, config.temperatureThresholds)));
  if (core != null) (coreMesh.material as THREE.MeshBasicMaterial).color.copy(threeColor(tireTempColor(core, config.temperatureThresholds)));
  (resource.meshes[1].material as THREE.MeshBasicMaterial).color.copy(threeColor(config.rimColor));
  const brake = resource.meshes[4 + resource.geometries.surfaceBands.length];
  brake.visible = config.brakeTemp > 0; brake.position.z = config.side === "left" ? (config.tireWidth ?? 0.3) * 0.6 : -(config.tireWidth ?? 0.3) * 0.6;
  if (config.brakeTemp > 0) (brake.material as THREE.MeshBasicMaterial).color.copy(threeColor(brakeTempColor(config.brakeTemp, config.isRear)));
}
export function setWheelSpin(resource: WheelResource, rotationSpeed: number, elapsed: number, playbackSpeed: number, playing: boolean): void {
  if (playing && elapsed > 0 && elapsed < 0.25 && Math.abs(rotationSpeed) >= 0.5) resource.spin.rotation.z -= rotationSpeed * elapsed * playbackSpeed;
}
export function disposeWheelResource(resource: WheelResource): void {
  resource.root.removeFromParent();
  for (const material of resource.materials) material.dispose();
  for (const geometry of new Set([...resource.geometries.surfaceBands, resource.geometries.tire, resource.geometries.carcass, resource.geometries.core, resource.geometries.rim, ...resource.meshes.map((mesh) => mesh.geometry)])) geometry.dispose();
}
