import { useMemo, useRef, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";

const MODEL_PATH = "/models/f1_2025_mclaren_mcl39.glb";

function F1CarBody({ packet }: { packet: TelemetryPacket }) {
  const { scene } = useGLTF(MODEL_PATH);
  const groupRef = useRef<THREE.Group>(null);

  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = new THREE.MeshBasicMaterial({
          color: "#94a3b8",
          wireframe: true,
          transparent: true,
          opacity: 0.4,
        });
      }
    });

    // Log model info for debugging
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    console.log(`[F1Car] GLB size: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);

    return clone;
  }, [scene]);

  // Auto-scale and center
  const { scale, offset } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const s = maxDim > 0 ? 3 / maxDim : 1;
    const off = center.multiplyScalar(-s);
    return { scale: s, offset: off };
  }, [scene]);

  // Apply roll/pitch from telemetry
  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.rotation.x = packet.Pitch * 0.5;
    groupRef.current.rotation.z = -packet.Roll * 0.5;
  });

  return (
    <group ref={groupRef}>
      <group scale={scale} position={[offset.x, offset.y, offset.z]}>
        <primitive object={model} />
      </group>
    </group>
  );
}

useGLTF.preload(MODEL_PATH);

export function F1CarWireframeSection({ packet }: { packet: TelemetryPacket }) {
  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Car Attitude</h2>
      </div>
      <div className="h-56">
        <Canvas
          camera={{ position: [5, 3, 5], fov: 35 }}
          gl={{ antialias: true, alpha: true }}
          style={{ background: "transparent" }}
        >
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, 5, 5]} intensity={0.7} />
          <Suspense fallback={null}>
            <F1CarBody packet={packet} />
          </Suspense>
          <OrbitControls enablePan={false} enableZoom={true} />
          <gridHelper args={[10, 10, "#1e293b", "#1e293b"]} position={[0, -1.5, 0]} />
        </Canvas>
      </div>
    </div>
  );
}
