import { useRef, useState, useEffect, useMemo, Suspense } from "react";
import { useFrame } from "@react-three/fiber";
import { Grid } from "@react-three/drei";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import type { CarModelEnrichment } from "../../data/car-models";
import type { ViewToggles, ViewPreset } from "../../lib/wireframe-data";
import { allWheelStates, tireState } from "../../lib/vehicle-dynamics";
import { useRequiredGameId } from "../../stores/game";
import { useTirePressureOptimal } from "../../hooks/queries";
import { CarBody } from "./CarBody";
import { Wheel } from "./Wheel";
import { SuspensionSpring } from "./SuspensionSpring";
import { TireTrails } from "./TireTrails";
import { InputOverlay } from "./InputOverlay";
import { CurbMarkers } from "./CurbMarkers";
import { TrackOutline, TrackBoundaryEdges } from "./TrackElements";
import { DimensionLines } from "./DimensionLines";
import { AutoChaseCamera, CameraController } from "./CameraControllers";

// Load-dot geometry: direction comes from the baseline-subtracted weighted
// centroid (which corner is dominant), magnitude comes from the *max*
// normalized compression (how hard that corner is loaded). Dot reaches a
// corner edge only when that corner is at 100% compression AND the others
// are at the baseline.
function computeLoadDotXZ(
  susp: [number, number, number, number],
  wb: number,
  ft: number,
  rt: number,
): { x: number; z: number } | null {
  const base = Math.min(susp[0], susp[1], susp[2], susp[3]);
  const maxC = Math.max(susp[0], susp[1], susp[2], susp[3]);
  const w0 = susp[0] - base;
  const w1 = susp[1] - base;
  const w2 = susp[2] - base;
  const w3 = susp[3] - base;
  const total = w0 + w1 + w2 + w3;
  if (total < 1e-4) return { x: 0, z: 0 };
  const cornerX = [wb, wb, -wb, -wb];
  const cornerZ = [-ft + 0.35, ft - 0.35, -rt + 0.35, rt - 0.35];
  const dirX = (cornerX[0] * w0 + cornerX[1] * w1 + cornerX[2] * w2 + cornerX[3] * w3) / total;
  const dirZ = (cornerZ[0] * w0 + cornerZ[1] * w1 + cornerZ[2] * w2 + cornerZ[3] * w3) / total;
  const scale = Math.min(1, maxC);
  return { x: dirX * scale, z: dirZ * scale };
}

export function CarScene({ packet: packetProp, telemetry, cursorIdx, outline, boundaries, toggles, viewPreset, carModel, modelOffsetX, fmtTemp, hideModelWheels, suspThresholds, autoOrbit, tireColors }: { packet: TelemetryPacket; telemetry: TelemetryPacket[]; cursorIdx: number; outline: { x: number; z: number }[] | null; boundaries: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[] } | null; toggles: ViewToggles; viewPreset: ViewPreset; carModel: CarModelEnrichment & { hasModel: boolean }; modelOffsetX: number; fmtTemp: (f: number) => string; hideModelWheels?: boolean; suspThresholds: number[]; autoOrbit?: boolean; tireColors: [string, string, string, string] }) {
  const [colorFL, colorFR, colorRL, colorRR] = tireColors;
  const gameId = useRequiredGameId();
  const pressureOptimal = useTirePressureOptimal(gameId, packetProp.CarOrdinal);

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

  // Body drops when suspension compresses (wheels stay on ground).
  // Per-car stroke from CarModelEnrichment.suspStroke (metres, total travel);
  // ACC and F1 don't populate this and fall back to the 80mm GT3 default.
  const stroke = carModel.suspStroke ?? 0.08;
  const dropFL = -(suspFL - 0.5) * stroke;
  const dropFR = -(suspFR - 0.5) * stroke;
  const dropRL = -(suspRL - 0.5) * stroke;
  const dropRR = -(suspRR - 0.5) * stroke;
  const avgSusp = (suspFL + suspFR + suspRL + suspRR) / 4;
  const bodyDrop = -(avgSusp - 0.5) * stroke;

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
    if (carGroupRef.current) {
      carGroupRef.current.position.set(posOffset, bodyDrop, 0);
      carGroupRef.current.rotation.set(
        bodyRoll,
        0,
        bodyPitch,
        "YXZ"
      );
    }
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

  // All games: fronts rotate by the normalized Steer input scaled to a
  // ballpark max front wheel angle; rears stay at 0. ACC's tyreContactHeading
  // field is parsed into acc.tireContactHeading for potential future use but
  // isn't used here — in practice the field tracks tire velocity direction
  // more than the physical wheel axle, so steering barely moves it.
  const steerFL = steerRad;
  const steerFR = steerRad;
  const steerRL = 0;
  const steerRR = 0;

  // Camber rendering is currently disabled for every game. ACC is the only
  // title exposing a camber field (camberRAD[4] in the shared memory Physics
  // page) and Kunos ships it as a zeroed stub — reading it produces no
  // visible effect. The parser still reads it into packet.acc.tireCamber so
  // this can be re-enabled (along with the Camber UI toggle) the moment ACC
  // or AC Evo starts writing real values.
  const cambFL = 0;
  const cambFR = 0;
  const cambRL = 0;
  const cambRR = 0;

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
  const pressFL = packet.TirePressureFrontLeft ?? packet.f1?.tyrePressureFL ?? 0;
  const pressFR = packet.TirePressureFrontRight ?? packet.f1?.tyrePressureFR ?? 0;
  const pressRL = packet.TirePressureRearLeft ?? packet.f1?.tyrePressureRL ?? 0;
  const pressRR = packet.TirePressureRearRight ?? packet.f1?.tyrePressureRR ?? 0;
  const wheelData = [
    { pos: [wb, 0, -ft] as [number, number, number], steer: steerFL, camber: cambFL, susp: packet.NormSuspensionTravelFL, drop: dropFL, traction: tireState(ws.fl.state, ws.fl.slipRatio, packet.TireSlipAngleFL).hex, rimColor: colorFL, brakeTemp: packet.BrakeTempFrontLeft ?? packet.f1?.brakeTempFL ?? 0, pressure: pressFL, onRumble: packet.WheelOnRumbleStripFL !== 0, puddle: packet.WheelInPuddleDepthFL, wearRate: wearRatesVal[0], wear: packet.TireWearFL, rotSpeed: rotFL, tireRadius: fTireR, tireWidth: fTireW },
    { pos: [wb, 0, ft] as [number, number, number], steer: steerFR, camber: cambFR, susp: packet.NormSuspensionTravelFR, drop: dropFR, traction: tireState(ws.fr.state, ws.fr.slipRatio, packet.TireSlipAngleFR).hex, rimColor: colorFR, brakeTemp: packet.BrakeTempFrontRight ?? packet.f1?.brakeTempFR ?? 0, pressure: pressFR, onRumble: packet.WheelOnRumbleStripFR !== 0, puddle: packet.WheelInPuddleDepthFR, wearRate: wearRatesVal[1], wear: packet.TireWearFR, rotSpeed: rotFR, tireRadius: fTireR, tireWidth: fTireW },
    { pos: [-wb, 0, -rt] as [number, number, number], steer: steerRL, camber: cambRL, susp: packet.NormSuspensionTravelRL, drop: dropRL, traction: tireState(ws.rl.state, ws.rl.slipRatio, packet.TireSlipAngleRL).hex, rimColor: colorRL, brakeTemp: packet.BrakeTempRearLeft ?? packet.f1?.brakeTempRL ?? 0, pressure: pressRL, onRumble: packet.WheelOnRumbleStripRL !== 0, puddle: packet.WheelInPuddleDepthRL, wearRate: wearRatesVal[2], wear: packet.TireWearRL, rotSpeed: rotRL, tireRadius: rTireR, tireWidth: rTireW },
    { pos: [-wb, 0, rt] as [number, number, number], steer: steerRR, camber: cambRR, susp: packet.NormSuspensionTravelRR, drop: dropRR, traction: tireState(ws.rr.state, ws.rr.slipRatio, packet.TireSlipAngleRR).hex, rimColor: colorRR, brakeTemp: packet.BrakeTempRearRight ?? packet.f1?.brakeTempRR ?? 0, pressure: pressRR, onRumble: packet.WheelOnRumbleStripRR !== 0, puddle: packet.WheelInPuddleDepthRR, wearRate: wearRatesVal[3], wear: packet.TireWearRR, rotSpeed: rotRR, tireRadius: rTireR, tireWidth: rTireW },
  ];

  // Load distribution — weighted centroid of excess-compression per corner.
  // Dot reaches a corner iff that corner is at max compression (susp=1) while
  // the others are at/below static (susp≤0.5).
  const loadDot = (() => {
    const xz = computeLoadDotXZ([suspFL, suspFR, suspRL, suspRR], wb, ft, rt);
    if (!xz) return null;
    const springZMax = Math.max(ft - 0.35, rt - 0.35);
    return { x: xz.x, z: xz.z, y: 0.23 + bodyDrop, color: "#ef4444", springZMax };
  })();

  // Derive load-dot trail from the last 1s of lap time walked back from
  // cursorIdx. Uses packet.CurrentLap (lap-time seconds) so the window is
  // scoped to the current lap and resets cleanly at the lap boundary.
  // Pure derivation — persists on pause, reconstructs correctly on scrub.
  const loadTrail = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return [];
    const endLap = cur.CurrentLap;
    const pts: Array<[number, number]> = [];
    for (let i = cursorIdx; i >= 0; i--) {
      const p = telemetry[i];
      if (!p) break;
      // Stop at lap boundary: previous lap has a *larger* CurrentLap value
      // (lap time reset on crossing the line).
      if (p.CurrentLap > endLap) break;
      if (endLap - p.CurrentLap > 1) break;
      const xz = computeLoadDotXZ(
        [
          p.NormSuspensionTravelFL,
          p.NormSuspensionTravelFR,
          p.NormSuspensionTravelRL,
          p.NormSuspensionTravelRR,
        ],
        wb,
        ft,
        rt,
      );
      if (xz) pts.push([xz.x, xz.z]);
    }
    // Oldest first → newest last, matching the drawing direction of the Line.
    return pts.reverse();
  }, [telemetry, cursorIdx, wb, ft, rt]);

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={1} />
      <directionalLight position={[5, 8, 5]} intensity={2} />
      <directionalLight position={[-3, 4, -2]} intensity={1.2} />

      {/* Ground grid — scrolls with car movement.
          Scroll phase is taken in the car-local frame so section lines pass
          under the car along its forward/lateral axes, matching the same
          yaw transform used by TireTrails / TrackOutline / CurbMarkers. */}
      {toggles.grid && (() => {
        const gs = Math.sin(packet.Yaw);
        const gc = Math.cos(packet.Yaw);
        const gLocalX = packet.PositionX * gs + packet.PositionZ * gc;
        const gLocalZ = packet.PositionX * gc - packet.PositionZ * gs;
        return (
        <Grid
          args={[10, 10]}
          position={[
            -(gLocalX % 2),
            -0.45,
            -(gLocalZ % 2),
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
        );
      })()}

      {/* Body — rolls with pitch/roll */}
      <group ref={carGroupRef}>
        <Suspense fallback={null}>
          {carModel.hasModel && <CarBody solid={toggles.solid} carModel={carModel} modelOffsetX={modelOffsetX} hideModelWheels={hideModelWheels} />}
        </Suspense>
      </group>

      {/* Running gear — positioned by suspension */}
      <group>
        {/* Wheels */}
        {wheelData.map((w, i) => (
          <Wheel
            key={i}
            position={w.pos}
            steerAngle={w.steer}
            camberAngle={w.camber}
            gripColor={w.traction}
            rimColor={w.rimColor}
            rotationSpeed={w.rotSpeed}
            displayTemp={toggles.wheelInfo ? fmtTemp(i === 0 ? packet.TireTempFL : i === 1 ? packet.TireTempFR : i === 2 ? packet.TireTempRL : packet.TireTempRR) : ""}
            rimColorForDisplay={w.rimColor}
            brakeTemp={w.brakeTemp}
            pressurePsi={w.pressure}
            pressureOptimal={pressureOptimal}
            wearRate={w.wearRate}
            wear={w.wear}
            side={i % 2 === 0 ? "left" : "right"}
            isRear={i >= 2}
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
              bodyPos={[w.pos[0], 0.23 + w.drop, inboardZ]}
              wheelPos={[w.pos[0], 0, inboardZ]}
              suspTravel={w.susp}
              suspThresholds={suspThresholds}
            />
          );
        })}

        {/* Load distribution — weighted centroid dot between springs with 1s trail */}
        {toggles.springs && loadDot && (
          <group>
            {/* Crosshairs */}
            <Line points={[[-wb, loadDot.y, 0], [wb, loadDot.y, 0]]} color="#475569" lineWidth={0.5} />
            <Line points={[[0, loadDot.y, -loadDot.springZMax], [0, loadDot.y, loadDot.springZMax]]} color="#475569" lineWidth={0.5} />
            {/* 1 second trail — derived from packet history */}
            {loadTrail.length > 1 && (
              <Line
                points={loadTrail.map(([x, z]) => [x, loadDot.y, z] as [number, number, number])}
                color={loadDot.color}
                lineWidth={1.2}
                transparent
                opacity={0.55}
              />
            )}
            {/* Load dot */}
            <mesh position={[loadDot.x, loadDot.y, loadDot.z]}>
              <sphereGeometry args={[0.04, 8, 8]} />
              <meshBasicMaterial color={loadDot.color} />
            </mesh>
          </group>
        )}

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
