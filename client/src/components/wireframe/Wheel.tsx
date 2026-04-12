import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { makeWheelGeometries } from "../../lib/wireframe-utils";
import { brakeTempColor, COLORS_HEX } from "../../lib/vehicle-dynamics";
import { WheelInfoCard } from "./WheelLabels";

const useWheelGeometries = (radius = 0.34, width = 0.30) =>
  useMemo(() => makeWheelGeometries(radius, width), [radius, width]);

export function Wheel({
  position,
  steerAngle,
  camberAngle = 0,
  gripColor,
  rimColor,
  rotationSpeed,
  displayTemp,
  rimColorForDisplay,
  brakeTemp,
  pressurePsi,
  pressureOptimal,
  wearRate,
  wear,
  side,
  isRear,
  onCurb,
  puddleDepth,
  tireRadius = 0.34,
  tireWidth = 0.30,
}: {
  position: [number, number, number];
  steerAngle: number;
  camberAngle?: number; // radians, already sign-flipped per side by caller
  gripColor: string;
  rimColor: string;
  rotationSpeed: number;
  displayTemp: string;
  rimColorForDisplay: string;
  brakeTemp: number;
  pressurePsi: number;
  pressureOptimal?: { min: number; max: number };
  wearRate: number;
  wear: number;
  side: "left" | "right";
  isRear: boolean;
  onCurb: boolean;
  puddleDepth: number;
  tireRadius?: number;
  tireWidth?: number;
}) {
  const wheelY = position[1];
  const { tire, rim } = useWheelGeometries(tireRadius, tireWidth);
  const spinRef = useRef<THREE.Group>(null);

  // Accumulate spin every frame using wall-clock delta — works at any playback speed
  // Dead-band near-zero speeds to prevent reverse-wobble when paused
  useFrame((_, delta) => {
    if (!spinRef.current) return;
    if (Math.abs(rotationSpeed) < 0.5) return;
    spinRef.current.rotation.z -= rotationSpeed * delta;
  });

  return (
    <group position={[position[0], wheelY, position[2]]}>
      <group rotation={[0, steerAngle, 0]}>
        <group rotation={[camberAngle, 0, 0]}>
          <group ref={spinRef}>
            <mesh geometry={tire} renderOrder={10}>
              <meshBasicMaterial color={gripColor} wireframe depthTest={false} transparent />
            </mesh>
            <mesh geometry={rim} renderOrder={10}>
              <meshBasicMaterial color={rimColor} transparent opacity={0.85} side={THREE.DoubleSide} depthTest={false} />
            </mesh>
          </group>
        </group>
        {/* Brake disc — vertical, inboard of wheel (between wheel and spring) */}
        {brakeTemp > 0 && (
          <mesh
            position={[0, 0, side === "left" ? tireWidth * 0.6 : -tireWidth * 0.6]}
            rotation={[Math.PI / 2, 0, 0]}
            renderOrder={10}
          >
            <cylinderGeometry args={[tireRadius * 0.5, tireRadius * 0.5, 0.02, 24]} />
            <meshBasicMaterial color={COLORS_HEX[brakeTempColor(brakeTemp, isRear)]} transparent opacity={0.7} side={THREE.DoubleSide} depthTest={false} />
          </mesh>
        )}
      </group>
      {/* Unified info card — health / temp / brake / wear on one sprite */}
      {displayTemp && (
        <WheelInfoCard
          displayTemp={displayTemp}
          tempColor={rimColorForDisplay}
          wear={wear}
          wearRate={wearRate}
          brakeTemp={brakeTemp}
          pressurePsi={pressurePsi}
          pressureOptimal={pressureOptimal}
          side={side}
          isRear={isRear}
        />
      )}
      {/* Curb indicator — orange ring under tire when on rumble strip */}
      {onCurb && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -tireRadius, 0]}>
          <ringGeometry args={[tireRadius + 0.02, tireRadius + 0.10, 16]} />
          <meshBasicMaterial color="#ff8800" transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* Puddle indicator — blue disc under tire scaled by depth */}
      {puddleDepth > 0 && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -tireRadius, 0]}>
          <circleGeometry args={[tireRadius + 0.04 + puddleDepth * 0.15, 16]} />
          <meshBasicMaterial color="#3b82f6" transparent opacity={0.3 + puddleDepth * 0.4} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
