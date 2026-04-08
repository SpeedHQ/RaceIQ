import { useState, useMemo, useCallback, useEffect } from "react";
import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import type { CarModelEnrichment } from "../../data/car-models";

// Default hidden meshes for the bundled Aston Martin model
export const DEFAULT_HIDDEN_MESHES = new Set([
  94, 125, 126, 161, 183, 184, 211, 212, 214, 215, 217, 219,
  119, 120, 122, 123, 174, 175, 177, 178,
  7, 8,
]);

/**
 * Determine what action to take for a mesh given current display mode.
 * Returns "remove" | "solid" | "wire" to indicate the mesh treatment.
 */
export function classifyMesh(
  meshName: string,
  solid: "wire" | "solid" | "hidden",
  hideModelWheels: boolean,
  customHiddenMeshes?: number[],
): "remove" | "solid" | "wire" {
  const hiddenMeshes = customHiddenMeshes?.length ? new Set(customHiddenMeshes) : DEFAULT_HIDDEN_MESHES;
  const num = parseInt(meshName.replace(/\D/g, ""), 10);
  const isWheelMesh = hiddenMeshes.has(num);

  if (solid === "hidden") return "remove";
  if (isWheelMesh && (solid === "solid" || hideModelWheels)) return "remove";
  if (solid === "solid") return "solid";
  return "wire";
}

export function CarBody({ solid, carModel, modelOffsetX, hideModelWheels }: { solid: "wire" | "solid" | "hidden"; carModel: CarModelEnrichment & { hasModel: boolean }; modelOffsetX: number; hideModelWheels?: boolean }) {
  const { scene } = useGLTF(carModel.modelPath);

  const model = useMemo(() => {
    const clone = scene.clone(true);
    const toRemove: THREE.Object3D[] = [];
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const action = classifyMesh(mesh.name, solid, !!hideModelWheels, carModel.solidHiddenMeshes);

        if (action === "remove") {
          toRemove.push(mesh);
        } else if (action === "solid") {
          mesh.material = new THREE.MeshStandardMaterial({
            color: "#4a6a8a",
            metalness: 0.7,
            roughness: 0.25,
            side: THREE.DoubleSide,
          });
        } else {
          mesh.material = new THREE.MeshBasicMaterial({
            color: "#94a3b8",
            wireframe: true,
            transparent: true,
            opacity: 0.03,
          });
        }
      }
    });
    toRemove.forEach((obj) => obj.parent?.remove(obj));
    return clone;
  }, [scene, solid, hideModelWheels, carModel]);

  // Scale GLB to match our coordinate system.
  // If glbWheelbase is set, scale so it matches our wheelbase exactly.
  // Otherwise fall back to scaling by body length.
  const { scale: autoScale, offset } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    let s: number;
    if (carModel.glbWheelbase) {
      s = (carModel.halfWheelbase * 2) / carModel.glbWheelbase;
    } else {
      const lengthDim = Math.max(size.x, size.y, size.z);
      s = carModel.bodyLength / lengthDim;
    }

    const off = center.multiplyScalar(-s);
    // When model is rotated, model-local X becomes sideways — only apply offset if no rotation
    if (!carModel.glbRotationY) off.x += modelOffsetX;
    return { scale: s, offset: off };
  }, [scene, carModel, modelOffsetX]);

  const [highlightedMesh, setHighlightedMesh] = useState<string | null>(null);

  const handleDoubleClick = useCallback((e: { stopPropagation?: () => void; object?: THREE.Mesh }) => {
    e.stopPropagation?.();
    const mesh = e.object as THREE.Mesh | undefined;
    if (!mesh?.isMesh) return;
    const num = parseInt(mesh.name.replace(/\D/g, ""), 10);
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    console.log(`[CarBody] Clicked: ${mesh.name} (#${num}) [${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}]`);

    if (highlightedMesh === mesh.name) {
      setHighlightedMesh(null);
    } else {
      setHighlightedMesh(mesh.name);
    }
  }, [highlightedMesh]);

  // Apply highlight overlay
  useEffect(() => {
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.name === highlightedMesh) {
          mesh.material = new THREE.MeshBasicMaterial({ color: "#ff4444", wireframe: false, transparent: true, opacity: 0.6 });
        }
      }
    });
  }, [highlightedMesh, model]);

  return (
    <group rotation={[0, carModel.glbRotationY ?? 0, 0]}>
      <group scale={autoScale} position={[offset.x, offset.y + 0.25 + (carModel.glbOffsetY ?? 0), offset.z + (carModel.glbOffsetZ ?? 0)]}>
        <primitive object={model} onDoubleClick={handleDoubleClick} />
      </group>
    </group>
  );
}
