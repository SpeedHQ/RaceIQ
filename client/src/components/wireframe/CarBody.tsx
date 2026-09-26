import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer";
import type { CarModelEnrichment } from "../../data/car-models";
import { THREE_COLORS } from "../../lib/wireframe-utils";
import { classifyMesh } from "./classify-mesh";

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const modelCache = new Map<string, Promise<GLTF>>();

export function preloadCarModel(path: string): void {
  void loadModel(path).catch(() => {});
}

function loadModel(path: string): Promise<GLTF> {
  let cached = modelCache.get(path);
  if (!cached) {
    const request: Promise<GLTF> = loader.loadAsync(path).catch((reason: unknown) => {
      if (modelCache.get(path) === request) modelCache.delete(path);
      throw reason;
    });
    cached = request;
    modelCache.set(path, request);
  }
  return cached;
}

export function canonicalModelYawAlignment(modelPath: string): number {
  return modelPath === "/models/f1_2025_mclaren_mcl39_optimised.glb" || modelPath === "/models/peugeot_9x8_evo_2024_optimised.glb" ? Math.PI / 2 : 0;
}

export interface CarBodyInstance {
  root: THREE.Group;
  select(mesh: THREE.Mesh): void;
  dispose(): void;
}

/** Clone scene graph only; geometry and original materials remain cache-owned. */
export async function createCarBody(
  carModel: CarModelEnrichment & { hasModel: boolean },
  solid: "wire" | "solid" | "hidden",
  modelOffsetX: number,
  hideModelWheels = false,
): Promise<CarBodyInstance> {
  const { scene } = await loadModel(carModel.modelPath);
  const yawAlignment = canonicalModelYawAlignment(carModel.modelPath);
  const clone = scene.clone(true);
  const replacement =
    solid === "hidden"
      ? null
      : solid === "solid"
        ? new THREE.MeshStandardMaterial({
            color: THREE_COLORS.appTextDim,
            metalness: 0.7,
            roughness: 0.25,
            side: THREE.DoubleSide,
          })
        : new THREE.MeshBasicMaterial({
            color: THREE_COLORS.wireframeStructure,
            wireframe: true,
            transparent: true,
            opacity: 0.03,
          });
  const toRemove: THREE.Object3D[] = [];
  clone.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const action = classifyMesh(mesh.name, solid, hideModelWheels, carModel.solidHiddenMeshes);
    if (action === "remove") toRemove.push(mesh);
    else if (replacement) mesh.material = replacement;
  });
  for (const object of toRemove) object.parent?.remove(object);

  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const scale = carModel.glbWheelbase
    ? (carModel.halfWheelbase * 2) / carModel.glbWheelbase
    : carModel.bodyLength / Math.max(size.x, size.y, size.z);
  const offset = center.multiplyScalar(-scale);
  if (yawAlignment === 0) offset.x += modelOffsetX;
  const root = new THREE.Group();
  root.rotation.y = yawAlignment;
  const scaled = new THREE.Group();
  scaled.scale.setScalar(scale);
  scaled.position.set(offset.x, offset.y + 0.25 + (carModel.glbOffsetY ?? 0), offset.z + (carModel.glbOffsetZ ?? 0));
  scaled.add(clone);
  root.add(scaled);

  let selected: string | null = null;
  let highlighted: THREE.Mesh[] = [];
  let originalMaterials: THREE.Material[] = [];
  let highlightMaterial: THREE.MeshBasicMaterial | null = null;
  function clearHighlight(): void {
    highlighted.forEach((mesh, index) => {
      if (mesh.material === highlightMaterial) mesh.material = originalMaterials[index];
    });
    highlightMaterial?.dispose();
    highlightMaterial = null;
    highlighted = [];
    originalMaterials = [];
  }
  return {
    root,
    select(mesh) {
      if (!mesh.isMesh) return;
      const num = parseInt(mesh.name.replace(/\D/g, ""), 10);
      const dimensions = new THREE.Vector3();
      new THREE.Box3().setFromObject(mesh).getSize(dimensions);
      console.log(`[CarBody] Clicked: ${mesh.name} (#${num}) [${dimensions.x.toFixed(2)} x ${dimensions.y.toFixed(2)} x ${dimensions.z.toFixed(2)}]`);
      const next = selected === mesh.name ? null : mesh.name;
      clearHighlight();
      selected = next;
      if (!next) return;
      clone.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && child.name === next) highlighted.push(child as THREE.Mesh);
      });
      if (!highlighted.length) return;
      originalMaterials = highlighted.map((item) => item.material as THREE.Material);
      highlightMaterial = new THREE.MeshBasicMaterial({
        color: THREE_COLORS.wireframeAlert,
        transparent: true,
        opacity: 0.6,
      });
      for (const item of highlighted) item.material = highlightMaterial;
    },
    dispose() {
      clearHighlight();
      root.removeFromParent();
      replacement?.dispose();
    },
  };
}
