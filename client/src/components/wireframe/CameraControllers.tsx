import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { semanticNumber, type SemanticAnalysisFrame } from "../analyse/track-map/types";
import { VIEW_PRESETS, type ViewPreset } from "../../lib/wireframe-data";

export function AutoChaseCamera({ packet }: { packet: SemanticAnalysisFrame }) {
  const { camera } = useThree();
  const smoothYaw = useRef((semanticNumber(packet, "motion.yaw") ?? 0));

  useFrame(() => {
    // Smooth the yaw to avoid jerky camera
    let diff = (semanticNumber(packet, "motion.yaw") ?? 0) - smoothYaw.current;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    smoothYaw.current += diff * 0.04;

    const yaw = smoothYaw.current;
    const radius = 5;
    const height = 1.8;
    // Camera sits behind the car: car faces -Z in Forza coords, yaw=0 is forward
    camera.position.set(Math.sin(yaw) * radius, height, Math.cos(yaw) * radius);
    camera.lookAt(0, 0.3, 0);
  });

  return null;
}

export function CameraController({ viewPreset }: { viewPreset: ViewPreset }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const lastPreset = useRef<ViewPreset>(viewPreset);

  useFrame(() => {
    if (viewPreset !== lastPreset.current) {
      lastPreset.current = viewPreset;
      const preset = VIEW_PRESETS[viewPreset];
      camera.position.set(...preset.position);
      if (controlsRef.current) {
        controlsRef.current.target.set(...preset.target);
        controlsRef.current.update();
      }
    }
  });

  return <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={3} maxDistance={2000} minPolarAngle={0} maxPolarAngle={Math.PI} />;
}
