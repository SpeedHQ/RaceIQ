import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { TireTemperatureReading } from "../analyse/tire-temperature-profile";
import { brakeTempColor, tireTempColor } from "../../lib/vehicle-dynamics";
import { makeWheelGeometries, threeColor, THREE_COLORS } from "../../lib/wireframe-utils";
import { WheelInfoCard } from "./WheelLabels";

const useWheelGeometries = (radius = 0.34, width = 0.3) => useMemo(() => makeWheelGeometries(radius, width), [radius, width]);

export function Wheel({
  position,
  steerAngle,
  camberAngle = 0,
  rimColor,
  rotationSpeed,
  temperatureReadings,
  fmtTemp,
  temperatureThresholds,
  displayBrakeTemp,
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
  tireWidth = 0.3,
}: {
  position: [number, number, number];
  steerAngle: number;
  camberAngle?: number;
  rimColor: string;
  rotationSpeed: number;
  temperatureReadings: TireTemperatureReading[];
  fmtTemp: (value: number) => string;
  temperatureThresholds: { cold: number; warm: number; hot: number };
  displayBrakeTemp?: string | null;
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
  const { tire, surfaceBands, core, rim } = useWheelGeometries(tireRadius, tireWidth);
  const spinRef = useRef<THREE.Group>(null);
  const hasProfile = temperatureReadings.some(({ kind }) => kind === "inner" || kind === "middle" || kind === "outer");
  const treadReadings = temperatureReadings.filter(({ kind }) => kind !== "core");
  const coreReading = temperatureReadings.find(({ kind }) => kind === "core")?.value ?? null;
  const fallbackColor = temperatureReadings[0]?.value == null ? "var(--status-unavailable)" : tireTempColor(temperatureReadings[0].value, temperatureThresholds);

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
          {hasProfile ? (
            <>
              <mesh geometry={core} renderOrder={9}>
                <meshBasicMaterial color={threeColor(coreReading == null ? "var(--status-unavailable)" : tireTempColor(coreReading, temperatureThresholds))} wireframe transparent opacity={0.35} depthTest={false} />
              </mesh>
              {surfaceBands.map((geometry, index) => {
                const reading = treadReadings[index];
                return <mesh key={index} geometry={geometry} renderOrder={10}>
                  <meshBasicMaterial color={threeColor(reading?.value == null ? "var(--status-unavailable)" : tireTempColor(reading.value, temperatureThresholds))} wireframe transparent depthTest={false} />
                </mesh>;
              })}
            </>
          ) : (
            <mesh geometry={tire} renderOrder={10}>
              <meshBasicMaterial color={threeColor(fallbackColor)} wireframe depthTest={false} transparent />
            </mesh>
          )}
          <mesh geometry={rim} renderOrder={10}>
            <meshBasicMaterial color={threeColor(rimColor)} transparent opacity={0.85} side={THREE.DoubleSide} depthTest={false} />
          </mesh>
          </group>
        </group>
        {/* Brake disc — vertical, inboard of wheel (between wheel and spring) */}
        {brakeTemp > 0 && (
          <mesh position={[0, 0, side === "left" ? tireWidth * 0.6 : -tireWidth * 0.6]} rotation={[Math.PI / 2, 0, 0]} renderOrder={10}>
            <cylinderGeometry args={[tireRadius * 0.5, tireRadius * 0.5, 0.02, 24]} />
            <meshBasicMaterial color={threeColor(brakeTempColor(brakeTemp, isRear))} transparent opacity={0.7} side={THREE.DoubleSide} depthTest={false} />
          </mesh>
        )}
      </group>
      {temperatureReadings.length > 0 && (
        <WheelInfoCard
          temperatureReadings={temperatureReadings}
          fmtTemp={fmtTemp}
          temperatureThresholds={temperatureThresholds}
          wear={wear}
          wearRate={wearRate}
          displayBrakeTemp={displayBrakeTemp}
          brakeTemp={brakeTemp}
          pressurePsi={pressurePsi}
          pressureOptimal={pressureOptimal}
          side={side}
          isRear={isRear}
        />
      )}
      {/* Theme-owned curb indicator ring under the tire */}
      {onCurb && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -tireRadius, 0]}>
          <ringGeometry args={[tireRadius + 0.02, tireRadius + 0.1, 16]} />
          <meshBasicMaterial color={THREE_COLORS.surfaceContact} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* Theme-owned puddle indicator disc scaled by depth */}
      {puddleDepth > 0 && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -tireRadius, 0]}>
          <circleGeometry args={[tireRadius + 0.04 + puddleDepth * 0.15, 16]} />
          <meshBasicMaterial color={THREE_COLORS.surfaceWet} transparent opacity={0.3 + puddleDepth * 0.4} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
