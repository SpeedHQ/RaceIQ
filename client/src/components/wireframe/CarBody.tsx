import { useGLTF } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CarModelEnrichment } from "../../data/car-models";
import { THREE_COLORS } from "../../lib/wireframe-utils";
import { classifyMesh } from "./classify-mesh";

function mergeStaticModelMeshes(root: THREE.Object3D): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    let geometry = mesh.geometry.clone();
    if (!geometry.getAttribute("position")) {
      geometry.dispose();
      return;
    }
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.applyMatrix4(mesh.matrixWorld);
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== "position" && attribute !== "normal") geometry.deleteAttribute(attribute);
    }
    geometry.morphAttributes = {};
    geometry.morphTargetsRelative = false;
    if (geometry.index) {
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      geometry = nonIndexed;
    }
    geometries.push(geometry);
  });
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries);
  for (const geometry of geometries) geometry.dispose();
  return merged;
}

export function canonicalModelYawAlignment(modelPath: string): number {
  return modelPath === "/models/f1_2025_mclaren_mcl39_exterior.glb" ? Math.PI / 2 : 0;
}

export function CarBody({
  solid,
  carModel,
  modelOffsetX,
  hideModelWheels,
  mergeMeshes,
}: {
  solid: "wire" | "solid" | "hidden";
  carModel: CarModelEnrichment & { hasModel: boolean };
  modelOffsetX: number;
  hideModelWheels?: boolean;
  mergeMeshes?: boolean;
}) {
  const { scene } = useGLTF(carModel.modelPath);
  const yawAlignment = canonicalModelYawAlignment(carModel.modelPath);

  const { model, modelMaterial, modelGeometry } = useMemo(() => {
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
    for (const object of toRemove) object.parent?.remove(object);

    if (mergeMeshes && modelMaterial) {
      const modelGeometry = mergeStaticModelMeshes(clone);
      if (modelGeometry) {
        const mergedModel = new THREE.Mesh(modelGeometry, modelMaterial);
        mergedModel.name = "Merged car body";
        return { model: mergedModel, modelMaterial, modelGeometry };
      }
    }
    return { model: clone, modelMaterial, modelGeometry: null };
  }, [scene, solid, hideModelWheels, carModel, mergeMeshes]);

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
    if (yawAlignment === 0) off.x += modelOffsetX;
    return { scale: s, offset: off };
  }, [scene, carModel, modelOffsetX, yawAlignment]);

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
      modelGeometry?.dispose();
      modelMaterial?.dispose();
    },
    [modelGeometry, modelMaterial],
  );

  return (
    <group rotation={[0, yawAlignment, 0]}>
      <group scale={autoScale} position={[offset.x, offset.y + 0.25 + (carModel.glbOffsetY ?? 0), offset.z + (carModel.glbOffsetZ ?? 0)]}>
        {/* oxlint-disable-next-line a11y/noStaticElementInteractions: react-three primitive handles scene interaction rather than DOM interaction */}
        <primitive object={model} onDoubleClick={handleDoubleClick} dispose={null} />
      </group>
    </group>
  );
}
