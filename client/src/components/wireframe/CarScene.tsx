import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { Grid, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import type { GameId } from "../../../../shared/games/ids";
import type { CarModelEnrichment } from "../../data/car-models";
import { useTirePressureOptimal } from "../../hooks/catalog-queries";
import { normalizeSuspensionTravel } from "../../lib/suspension";
import { tireState } from "../../lib/vehicle-dynamics";
import type { ViewPreset, ViewToggles } from "../../lib/wireframe-data";
import { steeringAngleRadians, THREE_COLORS, visualWheelRotationSpeed } from "../../lib/wireframe-utils";
import { type SemanticAnalysisFrame, semanticNumber } from "../analyse/track-map/types";
import { AutoChaseCamera, CameraController } from "./CameraControllers";
import { CarBody } from "./CarBody";
import { CurbMarkers } from "./CurbMarkers";
import { DimensionLines } from "./DimensionLines";
import { InputOverlay } from "./InputOverlay";
import { SuspensionSpring } from "./SuspensionSpring";
import { TireTrails } from "./TireTrails";
import { TrackBoundaryEdges, TrackLine } from "./TrackElements";
import { Wheel } from "./Wheel";

// Load-dot geometry: direction comes from the baseline-subtracted weighted
// centroid (which corner is dominant), magnitude comes from the *max*
// normalized compression (how hard that corner is loaded). Dot reaches a
// corner edge only when that corner is at 100% compression AND the others
// are at the baseline.
const wheel = (f: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"], i: number) => {
  const v = f.values[id];
  return Array.isArray(v) && typeof v[i] === "number" && Number.isFinite(v[i]) ? (v[i] as number) : 0;
};

function normalizedSuspension(frame: SemanticAnalysisFrame, range?: { min: number; max: number }): [number, number, number, number] {
  const normalized = frame.values["suspension.norm-suspension-travel"];
  if (Array.isArray(normalized) && normalized.length >= 4 && normalized.slice(0, 4).every((value) => typeof value === "number" && Number.isFinite(value))) {
    return normalized.slice(0, 4) as [number, number, number, number];
  }
  return normalizeSuspensionTravel(frame.values["suspension.suspension-travel-m"] as unknown[], range);
}

function computeLoadDotXZ(susp: [number, number, number, number], wb: number, ft: number, rt: number): { x: number; z: number } | null {
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

export function CarScene({
  gameId,
  frame,
  telemetry,
  cursorIdx,
  outline,
  boundaries,
  toggles,
  viewPreset,
  carModel,
  modelOffsetX,
  fmtTemp,
  hideModelWheels,
  mergeBodyMeshes,
  suspThresholds,
  autoOrbit,
  tireColors,
}: {
  gameId: GameId;
  frame: SemanticAnalysisFrame;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
  boundaries: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[]; raceLine?: { x: number; z: number }[] | null } | null;
  toggles: ViewToggles;
  viewPreset: ViewPreset;
  carModel: CarModelEnrichment & { hasModel: boolean };
  modelOffsetX: number;
  fmtTemp: (f: number) => string;
  hideModelWheels?: boolean;
  suspThresholds: number[];
  mergeBodyMeshes?: boolean;
  autoOrbit?: boolean;
  tireColors: [string, string, string, string];
}) {
  const [colorFL, colorFR, colorRL, colorRR] = tireColors;
  const pressureOptimal = useTirePressureOptimal(gameId, 0);
  const hasWorldPositionTelemetry = useMemo(() => telemetry.some((f) => semanticNumber(f, "motion.position-x") != null && semanticNumber(f, "motion.position-z") != null), [telemetry]);

  const suspensionRange = gameId === "acc" ? { min: 0, max: 50 } : gameId === "iracing" ? { min: 0, max: 100 } : undefined;
  const [suspFL, suspFR, suspRL, suspRR] = normalizedSuspension(frame, suspensionRange);

  // Keep packet in a ref so useFrame reads latest without triggering re-render
  const packetRef = useRef(frame);
  useEffect(() => {
    packetRef.current = frame;
  });
  const carGroupRef = useRef<THREE.Group>(null);
  const prevTimeRef = useRef(semanticNumber(frame, "session.timestamp") ?? 0);
  const prevWear = useRef([wheel(frame, "tires.tire-wear", 0), wheel(frame, "tires.tire-wear", 1), wheel(frame, "tires.tire-wear", 2), wheel(frame, "tires.tire-wear", 3)]);
  const [wearRatesVal, setWearRatesVal] = useState([0, 0, 0, 0]);

  // Derive body roll/pitch from suspension deltas (not raw telemetry which includes track gradient)
  // Higher suspension travel = more compressed on that corner

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
      carGroupRef.current.rotation.set(bodyRoll, 0, bodyPitch, "YXZ");
    }
  });

  // Compute tire wear rate (/s) — smoothed with EMA
  useEffect(() => {
    const dt = (semanticNumber(frame, "session.timestamp") ?? 0 - prevTimeRef.current) / 1000;
    prevTimeRef.current = semanticNumber(frame, "session.timestamp") ?? 0;
    const currentWear = [wheel(frame, "tires.tire-wear", 0), wheel(frame, "tires.tire-wear", 1), wheel(frame, "tires.tire-wear", 2), wheel(frame, "tires.tire-wear", 3)];
    if (dt > 0 && dt < 1) {
      setWearRatesVal((prev) => {
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

  const steerRad = steeringAngleRadians(semanticNumber(frame, "inputs.steering") ?? 0);

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
  // visible effect. The parser still reads it into frame.acc.tireCamber so
  // this can be re-enabled (along with the Camber UI toggle) the moment ACC
  // or AC Evo starts writing real values.
  const cambFL = 0;
  const cambFR = 0;
  const cambRL = 0;
  const cambRR = 0;

  const fTireR = carModel.frontTireRadius ?? carModel.tireRadius;
  const rTireR = carModel.rearTireRadius ?? carModel.tireRadius;
  const vehicleSpeed = semanticNumber(frame, "motion.speed") ?? 0;
  const rotationValue = frame.values["tires.wheel-rotation-speed"];
  const measuredRotation = Array.isArray(rotationValue) ? rotationValue : undefined;
  const wheelRotationAvailable = resolveAnalysisTelemetry(getGame(gameId)).wheelRotation.source !== "unavailable";

  // Zero out wheel rotation during lockup — locked wheel = no spin
  const ws = {
    fl: { state: "nominal", slipRatio: wheel(frame, "tires.tire-slip-ratio", 0) },
    fr: { state: "nominal", slipRatio: wheel(frame, "tires.tire-slip-ratio", 1) },
    rl: { state: "nominal", slipRatio: wheel(frame, "tires.tire-slip-ratio", 2) },
    rr: { state: "nominal", slipRatio: wheel(frame, "tires.tire-slip-ratio", 3) },
  } as Record<"fl" | "fr" | "rl" | "rr", { state: "nominal" | "lockup"; slipRatio: number }>;

  // Preserve measured zeroes (including lockups). iRacing does not expose
  // per-wheel speed, so derive visual rolling from vehicle speed and tire radius.
  const rotFL = ws.fl.state === "lockup" ? 0 : visualWheelRotationSpeed(measuredRotation?.[0], vehicleSpeed, fTireR, wheelRotationAvailable);
  const rotFR = ws.fr.state === "lockup" ? 0 : visualWheelRotationSpeed(measuredRotation?.[1], vehicleSpeed, fTireR, wheelRotationAvailable);
  const rotRL = ws.rl.state === "lockup" ? 0 : visualWheelRotationSpeed(measuredRotation?.[2], vehicleSpeed, rTireR, wheelRotationAvailable);
  const rotRR = ws.rr.state === "lockup" ? 0 : visualWheelRotationSpeed(measuredRotation?.[3], vehicleSpeed, rTireR, wheelRotationAvailable);

  const wb = carModel.halfWheelbase;
  const ft = carModel.halfFrontTrack;
  const rt = carModel.halfRearTrack;
  const fTireW = carModel.frontTireWidth ?? 0.3;
  const rTireW = carModel.rearTireWidth ?? 0.3;
  const pressFL = semanticNumber(frame, "tires.tire-pressure") ?? 0;
  const pressFR = semanticNumber(frame, "tires.tire-pressure") ?? 0;
  const pressRL = semanticNumber(frame, "tires.tire-pressure") ?? 0;
  const pressRR = semanticNumber(frame, "tires.tire-pressure") ?? 0;
  const wheelData = [
    {
      id: "fl",
      pos: [wb, 0, -ft] as [number, number, number],
      steer: steerFL,
      camber: cambFL,
      susp: suspFL,
      drop: dropFL,
      traction: tireState(ws.fl.state, ws.fl.slipRatio, wheel(frame, "tires.tire-slip-angle", 0)).color,
      rimColor: colorFL,
      brakeTemp: wheel(frame, "brakes.brake-temp", 0),
      pressure: pressFL,
      onRumble: false,
      puddle: wheel(frame, "tires.wheel-in-puddle-depth", 0),
      wearRate: wearRatesVal[0],
      wear: wheel(frame, "tires.tire-wear", 0),
      rotSpeed: rotFL,
      tireRadius: fTireR,
      tireWidth: fTireW,
    },
    {
      id: "fr",
      pos: [wb, 0, ft] as [number, number, number],
      steer: steerFR,
      camber: cambFR,
      susp: suspFR,
      drop: dropFR,
      traction: tireState(ws.fr.state, ws.fr.slipRatio, wheel(frame, "tires.tire-slip-angle", 1)).color,
      rimColor: colorFR,
      brakeTemp: wheel(frame, "brakes.brake-temp", 1),
      pressure: pressFR,
      onRumble: false,
      puddle: wheel(frame, "tires.wheel-in-puddle-depth", 1),
      wearRate: wearRatesVal[1],
      wear: wheel(frame, "tires.tire-wear", 1),
      rotSpeed: rotFR,
      tireRadius: fTireR,
      tireWidth: fTireW,
    },
    {
      id: "rl",
      pos: [-wb, 0, -rt] as [number, number, number],
      steer: steerRL,
      camber: cambRL,
      susp: suspRL,
      drop: dropRL,
      traction: tireState(ws.rl.state, ws.rl.slipRatio, wheel(frame, "tires.tire-slip-angle", 2)).color,
      rimColor: colorRL,
      brakeTemp: wheel(frame, "brakes.brake-temp", 2),
      pressure: pressRL,
      onRumble: false,
      puddle: wheel(frame, "tires.wheel-in-puddle-depth", 2),
      wearRate: wearRatesVal[2],
      wear: wheel(frame, "tires.tire-wear", 2),
      rotSpeed: rotRL,
      tireRadius: rTireR,
      tireWidth: rTireW,
    },
    {
      id: "rr",
      pos: [-wb, 0, rt] as [number, number, number],
      steer: steerRR,
      camber: cambRR,
      susp: suspRR,
      drop: dropRR,
      traction: tireState(ws.rr.state, ws.rr.slipRatio, wheel(frame, "tires.tire-slip-angle", 3)).color,
      rimColor: colorRR,
      brakeTemp: wheel(frame, "brakes.brake-temp", 3),
      pressure: pressRR,
      onRumble: false,
      puddle: wheel(frame, "tires.wheel-in-puddle-depth", 3),
      wearRate: wearRatesVal[3],
      wear: wheel(frame, "tires.tire-wear", 3),
      rotSpeed: rotRR,
      tireRadius: rTireR,
      tireWidth: rTireW,
    },
  ];
  const loadDot = (() => {
    const xz = computeLoadDotXZ([suspFL, suspFR, suspRL, suspRR], wb, ft, rt);
    if (!xz) return null;
    const springZMax = Math.max(ft - 0.35, rt - 0.35);
    return { x: xz.x, z: xz.z, y: 0.23 + bodyDrop, color: THREE_COLORS.loadDistribution, springZMax };
  })();
  const loadTrail = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return [];
    const endLap = semanticNumber(cur, "timing.current-lap") ?? 0;
    const pts: Array<[number, number]> = [];
    for (let i = cursorIdx; i >= 0; i--) {
      const p = telemetry[i];
      if (!p) break;
      const lap = semanticNumber(p, "timing.current-lap") ?? 0;
      if (lap > endLap || endLap - lap > 1) break;
      const suspension = normalizedSuspension(p, suspensionRange ?? undefined);
      const xz = computeLoadDotXZ(suspension, wb, ft, rt);
      if (xz) pts.push([xz.x, xz.z]);
    }
    return pts.reverse();
  }, [telemetry, cursorIdx, wb, ft, rt, suspensionRange]);

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
      {toggles.grid &&
        (() => {
          const gs = Math.sin(semanticNumber(frame, "motion.yaw") ?? 0);
          const gc = Math.cos(semanticNumber(frame, "motion.yaw") ?? 0);
          const gLocalX = (semanticNumber(frame, "motion.position-x") ?? 0) * gs + (semanticNumber(frame, "motion.position-z") ?? 0) * gc;
          const gLocalZ = (semanticNumber(frame, "motion.position-x") ?? 0) * gc - (semanticNumber(frame, "motion.position-z") ?? 0) * gs;
          return (
            <Grid
              args={[10, 10]}
              position={[-(gLocalX % 2), -0.45, -(gLocalZ % 2)]}
              cellSize={0.5}
              cellThickness={0.5}
              cellColor={THREE_COLORS.appSurfaceAlt}
              sectionSize={2}
              sectionThickness={1}
              sectionColor={THREE_COLORS.appBorder}
              fadeDistance={8}
              infiniteGrid
            />
          );
        })()}

      {/* Body — rolls with pitch/roll */}
      <group ref={carGroupRef}>
        <Suspense fallback={null}>
          {carModel.hasModel && <CarBody solid={toggles.solid} carModel={carModel} modelOffsetX={modelOffsetX} hideModelWheels={hideModelWheels} mergeMeshes={mergeBodyMeshes} />}
        </Suspense>
      </group>

      {/* Running gear — positioned by suspension */}
      <group>
        {/* Wheels */}
        {wheelData.map((w, i) => (
          <Wheel
            key={w.id}
            position={w.pos}
            steerAngle={w.steer}
            camberAngle={w.camber}
            gripColor={w.traction}
            rimColor={w.rimColor}
            rotationSpeed={w.rotSpeed}
            displayTemp={toggles.wheelInfo ? fmtTemp(wheel(frame, "tire.temperature.average", i)) : ""}
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
        {toggles.springs &&
          wheelData.map((w, _i) => {
            const inboardZ = w.pos[2] > 0 ? w.pos[2] - 0.35 : w.pos[2] + 0.35;
            return <SuspensionSpring key={`susp-${w.id}`} bodyPos={[w.pos[0], 0.23 + w.drop, inboardZ]} wheelPos={[w.pos[0], 0, inboardZ]} suspTravel={w.susp} suspThresholds={suspThresholds} />;
          })}

        {/* Load distribution — weighted centroid dot between springs with 1s trail */}
        {toggles.springs && loadDot && (
          <group>
            {/* Crosshairs */}
            <Line
              points={[
                [-wb, loadDot.y, 0],
                [wb, loadDot.y, 0],
              ]}
              color={THREE_COLORS.appBorder}
              lineWidth={0.5}
            />
            <Line
              points={[
                [0, loadDot.y, -loadDot.springZMax],
                [0, loadDot.y, loadDot.springZMax],
              ]}
              color={THREE_COLORS.appBorder}
              lineWidth={0.5}
            />
            {/* 1 second trail — derived from packet history */}
            {loadTrail.length > 1 && <Line points={loadTrail.map(([x, z]) => [x, loadDot.y, z] as [number, number, number])} color={loadDot.color} lineWidth={1.2} transparent opacity={0.55} />}
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
              points={[
                [wb, 0, -ft],
                [wb, 0, ft],
              ]}
              color={THREE_COLORS.appTextDim}
              lineWidth={2}
            />
            {/* Rear axle */}
            <Line
              points={[
                [-wb, 0, -rt],
                [-wb, 0, rt],
              ]}
              color={THREE_COLORS.appTextDim}
              lineWidth={2}
            />
            {/* Driveshaft */}
            <Line
              points={[
                [wb, 0, 0],
                [-wb, 0, 0],
              ]}
              color={THREE_COLORS.wireframeStructure}
              lineWidth={1.5}
            />
            {/* Differential housings */}
            <mesh position={[wb, 0, 0]}>
              <boxGeometry args={[0.15, 0.12, 0.2]} />
              <meshBasicMaterial color={THREE_COLORS.appTextDim} wireframe />
            </mesh>
            <mesh position={[-wb, 0, 0]}>
              <boxGeometry args={[0.15, 0.12, 0.2]} />
              <meshBasicMaterial color={THREE_COLORS.appTextDim} wireframe />
            </mesh>
          </>
        )}
      </group>

      {/* Track outline (center line) */}
      {toggles.track && outline && <TrackLine points={outline} packet={frame} distAhead={autoOrbit ? 80 : undefined} />}

      {/* Game-provided reference racing line */}
      {toggles.racingLine && boundaries?.raceLine && boundaries.raceLine.length > 1 && (
        <TrackLine points={boundaries.raceLine} packet={frame} color={THREE_COLORS.trackRacingLine} lineWidth={4} opacity={1} y={-0.435} distAhead={autoOrbit ? 80 : undefined} />
      )}

      {/* Track boundary edges (walls) */}
      {toggles.track && boundaries && <TrackBoundaryEdges boundaries={boundaries} packet={frame} tireRadius={carModel.tireRadius} distAhead={autoOrbit ? 80 : undefined} />}

      {/* Curb + puddle markers on track surface */}
      {toggles.track && hasWorldPositionTelemetry && <CurbMarkers telemetry={telemetry} cursorIdx={cursorIdx} packet={frame} carModel={carModel} />}

      {/* Dimension measurement lines */}
      {toggles.dimensions && <DimensionLines carModel={carModel} />}

      {/* Tire trails (ground, colored by slip) */}
      {toggles.trails && <TireTrails telemetry={telemetry} cursorIdx={cursorIdx} carModel={carModel} />}

      {/* Throttle/brake input overlay */}
      {toggles.inputs && hasWorldPositionTelemetry && <InputOverlay telemetry={telemetry} packet={frame} />}

      {/* Camera controls */}
      {autoOrbit ? <AutoChaseCamera packet={frame} /> : <CameraController viewPreset={viewPreset} />}
    </>
  );
}
