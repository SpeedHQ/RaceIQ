import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { makeWheelGeometries, brakeTempColor } from "../../lib/wireframe-utils";
import { TempLabel, WearLabel, BrakeTempLabel, HealthLabel } from "./WheelLabels";

const useWheelGeometries = (radius = 0.34, width = 0.30) =>
  useMemo(() => makeWheelGeometries(radius, width), [radius, width]);

export function Wheel({
  position,
  steerAngle,
  gripColor,
  rimColor,
  rotationSpeed,
  displayTemp,
  rimColorForDisplay,
  brakeTemp,
  wearRate,
  wear,
  side,
  onCurb,
  puddleDepth,
  tireRadius = 0.34,
  tireWidth = 0.30,
}: {
  position: [number, number, number];
  steerAngle: number;
  gripColor: string;
  rimColor: string;
  rotationSpeed: number;
  displayTemp: string;
  rimColorForDisplay: string;
  brakeTemp: number;
  wearRate: number;
  wear: number;
  side: "left" | "right";
  onCurb: boolean;
  puddleDepth: number;
  tireRadius?: number;
  tireWidth?: number;
}) {
  const wheelY = position[1];
  const { tire, rim, hub } = useWheelGeometries(tireRadius, tireWidth);
  const spinRef = useRef<THREE.Group>(null);

  // Accumulate spin every frame using wall-clock delta — works at any playback speed
  // Dead-band near-zero speeds to prevent reverse-wobble when paused
  useFrame((_, delta) => {
    if (!spinRef.current) return;
    if (Math.abs(rotationSpeed) < 0.5) return;
    spinRef.current.rotation.z += rotationSpeed * delta * 0.3;
  });

  return (
    <group position={[position[0], wheelY, position[2]]}>
      <group rotation={[0, steerAngle, 0]}>
        <group ref={spinRef}>
          <mesh geometry={tire}>
            <meshBasicMaterial color={gripColor} wireframe />
          </mesh>
          <mesh geometry={rim}>
            <meshBasicMaterial color={rimColor} transparent opacity={0.85} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={hub}>
            <meshBasicMaterial color="#475569" wireframe side={THREE.DoubleSide} />
          </mesh>
        </group>
        {/* Brake disc — vertical, inboard of wheel (between wheel and spring) */}
        {brakeTemp > 0 && (
          <mesh position={[0, 0, side === "left" ? tireWidth * 0.6 : -tireWidth * 0.6]} rotation={[0, 0, 0]}>
            <torusGeometry args={[tireRadius * 0.48, 0.016, 4, 24]} />
            <meshBasicMaterial color={brakeTempColor(brakeTemp)} transparent opacity={0.7} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>
      {/* Temp / health / wear labels — only when there's live data */}
      {displayTemp && (
        <>
          <TempLabel displayTemp={displayTemp} color={rimColorForDisplay} side={side} />
          <HealthLabel wear={wear} side={side} />
          <WearLabel wearRate={wearRate} side={side} />
          {brakeTemp > 0 && <BrakeTempLabel temp={brakeTemp} side={side} />}
        </>
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
