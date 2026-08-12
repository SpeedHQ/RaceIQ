import { useGLTF } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { CarModelEnrichment } from "../../data/car-models";
import { THREE_COLORS } from "../../lib/wireframe-utils";
import { classifyMesh } from "./classify-mesh";

export function CarBody({
  solid,
  carModel,
  modelOffsetX,
  hideModelWheels,
}: {
  solid: "wire" | "solid" | "hidden";
  carModel: CarModelEnrichment & { hasModel: boolean };
  modelOffsetX: number;
  hideModelWheels?: boolean;
}) {
  const { scene } = useGLTF(carModel.modelPath);

  const { model, modelMaterial } = useMemo(() => {
    const clone = scene.clone(true);
    const toRemove: THREE.Object3D[] = [];
    const modelMaterial =
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

    clone.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;

      const mesh = child as THREE.Mesh;
      const action = classifyMesh(mesh.name, solid, !!hideModelWheels, carModel.solidHiddenMeshes);
      if (action === "remove") {
        toRemove.push(mesh);
      } else if (modelMaterial) {
        mesh.material = modelMaterial;
      }
    });
    toRemove.forEach((obj) => {
      obj.parent?.remove(obj);
    });
    return { model: clone, modelMaterial };
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

  const handleDoubleClick = useCallback(
    (e: { stopPropagation?: () => void; object?: THREE.Mesh }) => {
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
    },
    [highlightedMesh],
  );

  // Apply one temporary highlight material, then restore clone-owned materials.
  useEffect(() => {
    if (!highlightedMesh) return;

    const meshes: THREE.Mesh[] = [];
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.name === highlightedMesh) {
        meshes.push(child as THREE.Mesh);
      }
    });
    if (meshes.length === 0) return;

    const originals = meshes.map((mesh) => mesh.material);
    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: THREE_COLORS.wireframeAlert,
      wireframe: false,
      transparent: true,
      opacity: 0.6,
    });
    meshes.forEach((mesh) => {
      mesh.material = highlightMaterial;
    });

    return () => {
      meshes.forEach((mesh, index) => {
        if (mesh.material === highlightMaterial) {
          mesh.material = originals[index];
        }
      });
      highlightMaterial.dispose();
    };
  }, [highlightedMesh, model]);

  useEffect(
    () => () => {
      modelMaterial?.dispose();
    },
    [modelMaterial],
  );

  return (
    <group rotation={[0, carModel.glbRotationY ?? 0, 0]}>
      <group scale={autoScale} position={[offset.x, offset.y + 0.25 + (carModel.glbOffsetY ?? 0), offset.z + (carModel.glbOffsetZ ?? 0)]}>
        {/* oxlint-disable-next-line a11y/noStaticElementInteractions: react-three primitive handles scene interaction rather than DOM interaction */}
        <primitive object={model} onDoubleClick={handleDoubleClick} dispose={null} />
      </group>
    </group>
  );
}
