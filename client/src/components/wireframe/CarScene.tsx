import { useRef, useState, useEffect, Suspense } from "react";
import { useFrame } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import type { CarModelEnrichment } from "../../data/car-models";
import type { ViewToggles, ViewPreset } from "../../lib/wireframe-data";
import { allWheelStates, tireState } from "../../lib/vehicle-dynamics";
import { CarBody } from "./CarBody";
import { Wheel } from "./Wheel";
import { SuspensionSpring } from "./SuspensionSpring";
import { TireTrails } from "./TireTrails";
import { InputOverlay } from "./InputOverlay";
import { CurbMarkers } from "./CurbMarkers";
import { TrackOutline, TrackBoundaryEdges } from "./TrackElements";
import { DimensionLines } from "./DimensionLines";
import { AutoChaseCamera, CameraController } from "./CameraControllers";

export function CarScene({ packet: packetProp, telemetry, cursorIdx, outline, boundaries, toggles, viewPreset, carModel, modelOffsetX, fmtTemp, hideModelWheels, suspThresholds, autoOrbit, tireColors }: { packet: TelemetryPacket; telemetry: TelemetryPacket[]; cursorIdx: number; outline: { x: number; z: number }[] | null; boundaries: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[] } | null; toggles: ViewToggles; viewPreset: ViewPreset; carModel: CarModelEnrichment & { hasModel: boolean }; modelOffsetX: number; fmtTemp: (f: number) => string; hideModelWheels?: boolean; suspThresholds: number[]; autoOrbit?: boolean; tireColors: [string, string, string, string] }) {
  const [colorFL, colorFR, colorRL, colorRR] = tireColors;

  // Keep packet in a ref so useFrame reads latest without triggering re-render
  const packetRef = useRef(packetProp);
  useEffect(() => { packetRef.current = packetProp; });
  const packet = packetProp; // still use prop for JSX (re-renders at 10fps)
  const carGroupRef = useRef<THREE.Group>(null);
  const prevTimeRef = useRef(packet.TimestampMS);
  const prevWear = useRef([packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR]);
  const [wearRatesVal, setWearRatesVal] = useState([0, 0, 0, 0]);

  // Derive body roll/pitch from suspension deltas (not raw telemetry which includes track gradient)
  // Higher suspension travel = more compressed on that corner
  const suspFL = packet.NormSuspensionTravelFL;
  const suspFR = packet.NormSuspensionTravelFR;
  const suspRL = packet.NormSuspensionTravelRL;
  const suspRR = packet.NormSuspensionTravelRR;

  // Body drops when suspension compresses (wheels stay on ground)
  // GT3 total travel ~80mm (±40mm from neutral)
  const avgSusp = (suspFL + suspFR + suspRL + suspRR) / 4;
  const bodyDrop = -(avgSusp - 0.5) * 0.08;

  // Roll: ~5° max at full differential compression
  const leftAvg = (suspFL + suspRL) / 2;
  const rightAvg = (suspFR + suspRR) / 2;
  const bodyRoll = (rightAvg - leftAvg) * 0.1;

  // Pitch: ~3° max at full differential compression
  const frontAvg = (suspFL + suspFR) / 2;
  const rearAvg = (suspRL + suspRR) / 2;
  const bodyPitch = (frontAvg - rearAvg) * 0.06;

  // Forza PositionX/Z is ~0.065m ahead of geometric center, shift model back
  const posOffset = -0.065;
  useFrame(() => {
    if (!carGroupRef.current) return;
    carGroupRef.current.position.set(posOffset, bodyDrop, 0);
    carGroupRef.current.rotation.set(
      bodyRoll,
      0,
      bodyPitch,
      "YXZ"
    );
  });

  // Compute tire wear rate (/s) — smoothed with EMA
  useEffect(() => {
    const dt = (packet.TimestampMS - prevTimeRef.current) / 1000;
    prevTimeRef.current = packet.TimestampMS;
    const currentWear = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
    if (dt > 0 && dt < 1) {
      setWearRatesVal(prev => {
        const next = [...prev];
        for (let i = 0; i < 4; i++) {
          const rawRate = (prevWear.current[i] - currentWear[i]) / dt;
          next[i] = prev[i] * 0.9 + rawRate * 0.1;
        }
        return next;
      });
    }
    prevWear.current = currentWear;
  });

  const steerRad = -(packet.Steer / 127) * 0.35;

  // Zero out wheel rotation during lockup — locked wheel = no spin
  const ws = allWheelStates(packet);
  const rotFL = ws.fl.state === "lockup" ? 0 : packet.WheelRotationSpeedFL;
  const rotFR = ws.fr.state === "lockup" ? 0 : packet.WheelRotationSpeedFR;
  const rotRL = ws.rl.state === "lockup" ? 0 : packet.WheelRotationSpeedRL;
  const rotRR = ws.rr.state === "lockup" ? 0 : packet.WheelRotationSpeedRR;

  const wb = carModel.halfWheelbase;
  const ft = carModel.halfFrontTrack;
  const rt = carModel.halfRearTrack;
  const fTireR = carModel.frontTireRadius ?? carModel.tireRadius;
  const rTireR = carModel.rearTireRadius ?? carModel.tireRadius;
  const fTireW = carModel.frontTireWidth ?? 0.30;
  const rTireW = carModel.rearTireWidth ?? 0.30;
  const wheelData = [
    { pos: [wb, 0, -ft] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFL, traction: tireState(ws.fl.state, packet.TireCombinedSlipFL).hex, rimColor: colorFL, brakeTemp: packet.BrakeTempFrontLeft ?? packet.f1?.brakeTempFL ?? 0, onRumble: packet.WheelOnRumbleStripFL !== 0, puddle: packet.WheelInPuddleDepthFL, wearRate: wearRatesVal[0], wear: packet.TireWearFL, rotSpeed: rotFL, tireRadius: fTireR, tireWidth: fTireW },
    { pos: [wb, 0, ft] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFR, traction: tireState(ws.fr.state, packet.TireCombinedSlipFR).hex, rimColor: colorFR, brakeTemp: packet.BrakeTempFrontRight ?? packet.f1?.brakeTempFR ?? 0, onRumble: packet.WheelOnRumbleStripFR !== 0, puddle: packet.WheelInPuddleDepthFR, wearRate: wearRatesVal[1], wear: packet.TireWearFR, rotSpeed: rotFR, tireRadius: fTireR, tireWidth: fTireW },
    { pos: [-wb, 0, -rt] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRL, traction: tireState(ws.rl.state, packet.TireCombinedSlipRL).hex, rimColor: colorRL, brakeTemp: packet.BrakeTempRearLeft ?? packet.f1?.brakeTempRL ?? 0, onRumble: packet.WheelOnRumbleStripRL !== 0, puddle: packet.WheelInPuddleDepthRL, wearRate: wearRatesVal[2], wear: packet.TireWearRL, rotSpeed: rotRL, tireRadius: rTireR, tireWidth: rTireW },
    { pos: [-wb, 0, rt] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRR, traction: tireState(ws.rr.state, packet.TireCombinedSlipRR).hex, rimColor: colorRR, brakeTemp: packet.BrakeTempRearRight ?? packet.f1?.brakeTempRR ?? 0, onRumble: packet.WheelOnRumbleStripRR !== 0, puddle: packet.WheelInPuddleDepthRR, wearRate: wearRatesVal[3], wear: packet.TireWearRR, rotSpeed: rotRR, tireRadius: rTireR, tireWidth: rTireW },
  ];

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={1} />
      <directionalLight position={[5, 8, 5]} intensity={2} />
      <directionalLight position={[-3, 4, -2]} intensity={1.2} />

      {/* Ground grid — scrolls with car movement */}
      {toggles.grid && (
        <Grid
          args={[10, 10]}
          position={[
            -(packet.PositionX % 2),
            -0.45,
            -(packet.PositionZ % 2),
          ]}
          cellSize={0.5}
          cellThickness={0.5}
          cellColor="#1e293b"
          sectionSize={2}
          sectionThickness={1}
          sectionColor="#334155"
          fadeDistance={8}
          infiniteGrid
        />
      )}

      {/* Body — rolls with pitch/roll */}
      <group ref={carGroupRef}>
        <Suspense fallback={null}>
          {carModel.hasModel && <CarBody solid={toggles.solid} carModel={carModel} modelOffsetX={modelOffsetX} hideModelWheels={hideModelWheels} />}
        </Suspense>
        {/* Tail lights — glow red when braking */}
        {(() => {
          const braking = packet.Brake > 10;
          const color = braking ? "#ff2020" : "#661111";
          const intensity = braking ? 2 : 0;
          return (
            <>
              {/* Left tail light */}
              <mesh position={[-2.01, 0.22, -0.70]}>
                <boxGeometry args={[0.02, 0.08, 0.18]} />
                <meshBasicMaterial color={color} />
              </mesh>
              {/* Right tail light */}
              <mesh position={[-2.01, 0.22, 0.70]}>
                <boxGeometry args={[0.02, 0.08, 0.18]} />
                <meshBasicMaterial color={color} />
              </mesh>
              {/* Brake light glow */}
              {braking && (
                <pointLight position={[-2.10, 0.22, 0]} color="#ff2020" intensity={intensity} distance={2} decay={2} />
              )}
            </>
          );
        })()}
      </group>

      {/* Running gear — positioned by suspension */}
      <group>
        {/* Wheels */}
        {wheelData.map((w, i) => (
          <Wheel
            key={i}
            position={w.pos}
            steerAngle={w.steer}
            gripColor={w.traction}
            rimColor={w.rimColor}
            rotationSpeed={w.rotSpeed}
            displayTemp={fmtTemp(i === 0 ? packet.TireTempFL : i === 1 ? packet.TireTempFR : i === 2 ? packet.TireTempRL : packet.TireTempRR)}
            rimColorForDisplay={w.rimColor}
            brakeTemp={w.brakeTemp}
            wearRate={w.wearRate}
            wear={w.wear}
            side={i % 2 === 0 ? "left" : "right"}
            onCurb={w.onRumble}
            puddleDepth={w.puddle}
            tireRadius={w.tireRadius}
            tireWidth={w.tireWidth}
          />
        ))}

        {/* Suspension springs — connect dropped body to grounded wheels */}
        {toggles.springs && wheelData.map((w, i) => {
          const inboardZ = w.pos[2] > 0 ? w.pos[2] - 0.35 : w.pos[2] + 0.35;
          return (
            <SuspensionSpring
              key={`susp-${i}`}
              bodyPos={[w.pos[0], 0.23 + bodyDrop, inboardZ]}
              wheelPos={[w.pos[0], 0, inboardZ]}
              suspTravel={w.susp}
              suspThresholds={suspThresholds}
            />
          );
        })}

        {/* Load distribution — weighted centroid dot between springs */}
        {toggles.springs && (() => {
          const loads = [wheelData[0].susp, wheelData[1].susp, wheelData[2].susp, wheelData[3].susp];
          const total = loads[0] + loads[1] + loads[2] + loads[3];
          if (total < 0.01) return null;
          // Corner positions match spring inboard offsets (0.35 inboard of wheels)
          const corners = [
            { x: wb, z: -ft + 0.35 },
            { x: wb, z: ft - 0.35 },
            { x: -wb, z: -rt + 0.35 },
            { x: -wb, z: rt - 0.35 },
          ];
          let cx = 0, cz = 0;
          for (let i = 0; i < 4; i++) {
            cx += corners[i].x * loads[i];
            cz += corners[i].z * loads[i];
          }
          cx /= total;
          cz /= total;
          // Amplify offset from center for visibility
          const sensitivity = 3;
          const dotX = cx * sensitivity;
          const dotZ = cz * sensitivity;
          // Clamp within spring bounds
          const springZMax = Math.max(ft - 0.35, rt - 0.35);
          const clampX = Math.max(-wb, Math.min(wb, dotX));
          const clampZ = Math.max(-springZMax, Math.min(springZMax, dotZ));
          // Color by magnitude
          const dist = Math.sqrt(clampX * clampX + clampZ * clampZ);
          const maxDist = Math.sqrt(wb * wb + springZMax * springZMax);
          const mag = Math.min(1, dist / maxDist * 2);
          const dotColor = mag > 0.6 ? "#ef4444" : mag > 0.3 ? "#fbbf24" : "#34d399";
          const y = 0.23 + bodyDrop;
          return (
            <group>
              {/* Crosshairs */}
              <Line points={[[-wb, y, 0], [wb, y, 0]]} color="#475569" lineWidth={0.5} />
              <Line points={[[0, y, -springZMax], [0, y, springZMax]]} color="#475569" lineWidth={0.5} />
              {/* Load dot */}
              <mesh position={[clampX, y, clampZ]}>
                <sphereGeometry args={[0.04, 8, 8]} />
                <meshBasicMaterial color={dotColor} />
              </mesh>
            </group>
          );
        })()}

        {/* Drivetrain: axles, driveshaft, diff housings */}
        {toggles.drivetrain && (
          <>
            {/* Front axle */}
            <Line
              points={[[wb, 0, -ft], [wb, 0, ft]]}
              color="#64748b"
              lineWidth={2}
            />
            {/* Rear axle */}
            <Line
              points={[[-wb, 0, -rt], [-wb, 0, rt]]}
              color="#64748b"
              lineWidth={2}
            />
            {/* Driveshaft */}
            <Line
              points={[[wb, 0, 0], [-wb, 0, 0]]}
              color="#94a3b8"
              lineWidth={1.5}
            />
            {/* Differential housings */}
            <mesh position={[wb, 0, 0]}>
              <boxGeometry args={[0.15, 0.12, 0.2]} />
              <meshBasicMaterial color="#64748b" wireframe />
            </mesh>
            <mesh position={[-wb, 0, 0]}>
              <boxGeometry args={[0.15, 0.12, 0.2]} />
              <meshBasicMaterial color="#64748b" wireframe />
            </mesh>
          </>
        )}
      </group>

      {/* Track outline (center line) */}
      {toggles.track && outline && <TrackOutline outline={outline} packet={packet} distAhead={autoOrbit ? 80 : undefined} />}

      {/* Track boundary edges (walls) */}
      {toggles.track && boundaries && <TrackBoundaryEdges boundaries={boundaries} packet={packet} tireRadius={carModel.tireRadius} distAhead={autoOrbit ? 80 : undefined} />}

      {/* Curb + puddle markers on track surface */}
      {toggles.track && <CurbMarkers telemetry={telemetry} cursorIdx={cursorIdx} packet={packet} carModel={carModel} />}

      {/* Dimension measurement lines */}
      {toggles.dimensions && <DimensionLines carModel={carModel} />}

      {/* Tire trails (ground, colored by slip) */}
      {toggles.trails && <TireTrails telemetry={telemetry} cursorIdx={cursorIdx} carModel={carModel} />}

      {/* Throttle/brake input overlay */}
      {toggles.inputs && <InputOverlay telemetry={telemetry} packet={packet} />}

      {/* Camera controls */}
      {autoOrbit ? <AutoChaseCamera packet={packet} /> : <CameraController viewPreset={viewPreset} />}
    </>
  );
}
