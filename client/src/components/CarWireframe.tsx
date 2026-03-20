import { useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Edges, Line } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";

// ── Tire temp → color ──────────────────────────────────────────────

function tractionColor(slip: number): string {
  if (slip < 0.15) return "#34d399";   // full grip — green
  if (slip < 0.4) return "#22d3ee";    // slight slide — cyan
  if (slip < 0.8) return "#fbbf24";    // sliding — amber
  return "#ef4444";                     // loss of traction — red
}

// ── Wheel component ────────────────────────────────────────────────

// Pre-rotated geometries — baked orientation, no runtime Euler nesting
const useWheelGeometries = () =>
  useMemo(() => {
    // rotateX(PI/2) stands geometries upright: axis Y → Z (car lateral axle).
    const tire = new THREE.CylinderGeometry(0.34, 0.34, 0.18, 16, 1, false);
    tire.rotateX(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.22, 0.22, 0.19, 8, 1, true);
    rim.rotateX(Math.PI / 2);
    const hub = new THREE.CircleGeometry(0.22, 5);
    hub.rotateX(Math.PI / 2);
    return { tire, rim, hub };
  }, []);

// 0% = extended (wheel low), 100% = compressed (wheel up near body)
function suspY(suspTravel: number): number {
  return (suspTravel - 0.5) * 0.5;
}

function tireTempColor(temp: number): string {
  if (temp < 80) return "#3b82f6";
  if (temp < 100) return "#34d399";
  if (temp < 120) return "#fbbf24";
  return "#ef4444";
}

function Wheel({
  position,
  steerAngle,
  gripColor,
  tempColor,
  spinAngle,
}: {
  position: [number, number, number];
  steerAngle: number;
  gripColor: string;
  tempColor: string;
  spinAngle: number;
}) {
  const wheelY = position[1]; // wheels stay on the ground
  const { tire, rim, hub } = useWheelGeometries();

  return (
    <group position={[position[0], wheelY, position[2]]}>
      <group rotation={[0, steerAngle, 0]}>
        <group rotation={[0, 0, spinAngle]}>
          <mesh geometry={tire}>
            <meshBasicMaterial color={gripColor} wireframe />
          </mesh>
          <mesh geometry={rim}>
            <meshBasicMaterial color={tempColor} wireframe />
          </mesh>
          <mesh geometry={hub}>
            <meshBasicMaterial color="#475569" wireframe side={THREE.DoubleSide} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

// ── Suspension spring (coil + damper) ──────────────────────────────

function SuspensionSpring({
  bodyPos,
  wheelPos,
  suspTravel,
}: {
  bodyPos: [number, number, number];
  wheelPos: [number, number, number];
  suspTravel: number;
}) {
  const coilRadius = 0.032;  // ~64mm diameter (GT3 spec)
  const coils = 6;
  const segments = coils * 12;
  const topY = bodyPos[1];   // body mount (drops with body)
  const botY = wheelPos[1];  // wheel mount (stays on ground)
  const height = topY - botY;

  // Generate helix points
  const points = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * coils * Math.PI * 2;
      const y = botY + t * height;
      pts.push([
        bodyPos[0] + Math.cos(angle) * coilRadius,
        y,
        bodyPos[2] + Math.sin(angle) * coilRadius,
      ]);
    }
    return pts;
  }, [botY, height, bodyPos[0], bodyPos[2]]);

  // Color: green when neutral, amber when compressed, red when bottomed out
  // Red when heavily compressed (high travel), green when normal
  const color = suspTravel > 0.85 ? "#ef4444" : suspTravel > 0.6 ? "#fbbf24" : "#34d399";

  return (
    <group>
      {/* Coil spring */}
      <Line points={points} color={color} lineWidth={1.5} />
      {/* Damper rod (thin line through center) */}
      <Line
        points={[[bodyPos[0], topY + 0.05, bodyPos[2]], [bodyPos[0], botY - 0.05, bodyPos[2]]]}
        color="#64748b"
        lineWidth={1}
      />
    </group>
  );
}

// ── Car body wireframe ─────────────────────────────────────────────

function CarBody({ solid }: { solid: boolean }) {
  // Aston Martin GT3-style body — low, wide, long hood, fastback roofline
  const { wireGeo, solidGeo } = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    // All dimensions in meters, origin at car center
    const v = new Float32Array([
      // ── Floor outline (splitter/diffuser plane) ──
      // Rear diffuser (wide)
      -1.97, -0.05, -0.93,   // 0  rear-left
      -1.97, -0.05,  0.93,   // 1  rear-right
      // Rear wheel arch cutout (covers tires at z=±0.81)
      -1.57, -0.05, -1.02,   // 2  rear-left arch
      -1.57, -0.05,  1.02,   // 3  rear-right arch
      // Door sill
      -0.35, -0.05, -0.90,   // 4  mid-left
      -0.35, -0.05,  0.90,   // 5  mid-right
      // Front wheel arch (covers tires)
       1.14, -0.05, -1.02,   // 6  front-left arch
       1.14, -0.05,  1.02,   // 7  front-right arch
      // Front splitter
       1.92, -0.05, -0.75,   // 8  front-left
       1.92, -0.05,  0.75,   // 9  front-right
      // Nose tip
       2.23, -0.02, -0.35,   // 10 nose-left
       2.23, -0.02,  0.35,   // 11 nose-right
       2.36,  0.02,  0.00,   // 12 nose tip

      // ── Belt line (shoulder, fender tops) ──
      -1.92,  0.32, -0.93,   // 13 rear-left shoulder
      -1.92,  0.32,  0.93,   // 14 rear-right shoulder
      -1.49,  0.38, -1.02,   // 15 rear fender-left peak
      -1.49,  0.38,  1.02,   // 16 rear fender-right peak
      -0.35,  0.30, -0.90,   // 17 door-left top
      -0.35,  0.30,  0.90,   // 18 door-right top
       1.14,  0.36, -1.02,   // 19 front fender-left peak
       1.14,  0.36,  1.02,   // 20 front fender-right peak
       1.88,  0.22, -0.70,   // 21 hood-left edge
       1.88,  0.22,  0.70,   // 22 hood-right edge
       2.18,  0.12, -0.31,   // 23 nose-left top
       2.18,  0.12,  0.31,   // 24 nose-right top
       2.32,  0.08,  0.00,   // 25 nose tip top

      // ── Roof / greenhouse ──
      -0.70,  0.60, -0.46,   // 26 A-pillar left
      -0.70,  0.60,  0.46,   // 27 A-pillar right
       0.26,  0.62, -0.44,   // 28 roof peak left
       0.26,  0.62,  0.44,   // 29 roof peak right
      -1.31,  0.50, -0.42,   // 30 C-pillar left
      -1.31,  0.50,  0.42,   // 31 C-pillar right
      -1.66,  0.36, -0.40,   // 32 rear glass left
      -1.66,  0.36,  0.40,   // 33 rear glass right
       0.79,  0.55, -0.42,   // 34 windshield top left
       0.79,  0.55,  0.42,   // 35 windshield top right

      // ── Rear wing ──
      // Endplates (tall, wide)
      -2.05,  0.38, -0.88,   // 36 endplate left bottom
      -2.05,  0.38,  0.88,   // 37 endplate right bottom
      -2.05,  0.72, -0.88,   // 38 endplate left top
      -2.05,  0.72,  0.88,   // 39 endplate right top
      -2.23,  0.72, -0.88,   // 40 endplate left top rear
      -2.23,  0.72,  0.88,   // 41 endplate right top rear
      // Wing plane
      -2.01,  0.70, -0.86,   // 42 wing front left
      -2.01,  0.70,  0.86,   // 43 wing front right
      -2.27,  0.72, -0.86,   // 44 wing rear left
      -2.27,  0.72,  0.86,   // 45 wing rear right

      // ── Front splitter detail ──
       1.97, -0.08, -0.79,   // 46 splitter left
       1.97, -0.08,  0.79,   // 47 splitter right
       2.27, -0.06, -0.33,   // 48 splitter nose left
       2.27, -0.06,  0.33,   // 49 splitter nose right
    ]);

    const idx = [
      // Floor outline
      0,1, 0,2, 1,3, 2,4, 3,5, 4,6, 5,7, 6,8, 7,9, 8,10, 9,11, 10,12, 11,12,
      // Cross members floor
      2,3, 4,5, 6,7, 8,9, 10,11,
      // Belt line (shoulder)
      13,15, 15,17, 17,19, 19,21, 21,23, 23,25,
      14,16, 16,18, 18,20, 20,22, 22,24, 24,25,
      13,14, 15,16, 17,18, 19,20, 21,22, 23,24,
      // Verticals — floor to belt line
      0,13, 1,14, 2,15, 3,16, 4,17, 5,18, 6,19, 7,20, 8,21, 9,22, 10,23, 11,24, 12,25,
      // Roof / greenhouse
      26,27, 28,29, 30,31, 32,33, 34,35,
      26,28, 27,29, 28,34, 29,35, 30,32, 31,33,
      26,30, 27,31,
      // Pillars — belt line to roof
      17,26, 18,27, 19,34, 20,35, 13,32, 14,33,
      // Rear wing endplates
      36,38, 37,39, 38,40, 39,41, 36,37,
      38,39, 40,41,
      // Wing plane
      42,43, 44,45, 42,44, 43,45,
      // Wing to endplates
      42,38, 43,39, 44,40, 45,41,
      // Wing supports from body
      13,36, 14,37,
      // Front splitter
      46,47, 46,48, 47,49, 48,49,
      8,46, 9,47, 10,48, 11,49,
    ];

    geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
    geo.setIndex(idx);

    // Solid mesh — triangulated panels for opaque shell
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute("position", new THREE.BufferAttribute(v, 3));
    // Triangles for main body panels (using existing vertex indices)
    const tris = [
      // Floor
      0,1,3, 0,3,2, 2,3,5, 2,5,4, 4,5,7, 4,7,6, 6,7,9, 6,9,8, 8,9,11, 8,11,10, 10,11,12,
      // Left side (floor to belt)
      0,2,15, 0,15,13, 2,4,17, 2,17,15, 4,6,19, 4,19,17, 6,8,21, 6,21,19, 8,10,23, 8,23,21, 10,12,25, 10,25,23,
      // Right side
      1,14,16, 1,16,3, 3,16,18, 3,18,5, 5,18,20, 5,20,7, 7,20,22, 7,22,9, 9,22,24, 9,24,11, 11,24,25, 11,25,12,
      // Rear face
      0,13,14, 0,14,1,
      // Belt line top (hood/roof area)
      13,15,16, 13,16,14, 15,17,18, 15,18,16, 17,19,20, 17,20,18, 19,21,22, 19,22,20, 21,23,24, 21,24,22, 23,25,24,
      // Roof
      26,28,29, 26,29,27, 28,34,35, 28,35,29, 26,30,32, 26,27,31, 30,31,27, 30,27,26,
      // Windshield
      19,34,35, 19,35,20, 17,26,27, 17,27,18,
      // Rear glass
      13,32,33, 13,33,14, 30,32,33, 30,33,31,
      // Wing plane
      42,43,45, 42,45,44,
      // Splitter
      46,47,49, 46,49,48,
    ];
    sGeo.setIndex(tris);
    sGeo.computeVertexNormals();

    return { wireGeo: geo, solidGeo: sGeo };
  }, []);

  return (
    <group>
      {solid && (
        <mesh geometry={solidGeo}>
          <meshBasicMaterial color="#1a2332" side={THREE.DoubleSide} transparent opacity={0.9} />
        </mesh>
      )}
      <lineSegments geometry={wireGeo}>
        <lineBasicMaterial color="#94a3b8" opacity={0.7} transparent />
      </lineSegments>
    </group>
  );
}

// ── Tire trail (last 2s, colored by slip) ──────────────────────────

// Wheel offsets from car center (local space)
const WHEEL_OFFSETS: [number, number][] = [
  [1.35, -0.83],   // FL: x, z
  [1.35, 0.83],    // FR
  [-1.35, -0.81],  // RL
  [-1.35, 0.81],   // RR
];

// Pre-allocated color objects to avoid GC pressure
const SLIP_GREEN = new THREE.Color("#34d399");
const SLIP_AMBER = new THREE.Color("#fbbf24");
const SLIP_RED = new THREE.Color("#ef4444");

function slipColor(slip: number): string {
  if (slip < 0.3) return "#34d399";
  if (slip < 0.8) return "#fbbf24";
  return "#ef4444";
}

function slipColorObj(slip: number): THREE.Color {
  if (slip < 0.3) return SLIP_GREEN;
  if (slip < 0.8) return SLIP_AMBER;
  return SLIP_RED;
}

function TireTrails({
  telemetry,
  cursorIdx,
}: {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
}) {
  const trails = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return null;

    const curTime = cur.TimestampMS;
    const trailMs = 800;

    // Find start index (~2 seconds back)
    let startIdx = cursorIdx;
    while (startIdx > 0 && curTime - telemetry[startIdx].TimestampMS < trailMs) {
      startIdx--;
    }

    if (cursorIdx - startIdx < 2) return null;

    // Current car position/yaw for relative transform
    const cx = cur.PositionX;
    const cz = cur.PositionZ;
    const cyaw = cur.Yaw;
    // Forza: forward = (sin(Yaw), cos(Yaw))
    const curSin = Math.sin(cyaw);
    const curCos = Math.cos(cyaw);

    // Scale trail to fit scene (car is ~5m in scene, real trail can be 100m+)
    const scale = 0.06;

    const slips = [
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFL),
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFR),
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRL),
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRR),
    ];

    const wheelTrails: { points: [number, number, number][]; colors: string[] }[] = [];

    for (let w = 0; w < 4; w++) {
      const points: [number, number, number][] = [];
      const colors: string[] = [];
      const [wheelOffX, wheelOffZ] = WHEEL_OFFSETS[w];

      for (let i = startIdx; i <= cursorIdx; i += 5) {
        const p = telemetry[i];
        // Compute wheel world position using historical yaw
        const pSin = Math.sin(p.Yaw);
        const pCos = Math.cos(p.Yaw);
        // For front wheels, rotate offset by steer angle to get true contact patch position
        let fwd = wheelOffX;
        let rgt = wheelOffZ;
        if (w < 2) {
          const steer = (p.Steer / 127) * 0.35;
          const cs = Math.cos(steer), ss = Math.sin(steer);
          const rf = fwd * cs - rgt * ss;
          const rr = fwd * ss + rgt * cs;
          fwd = rf;
          rgt = rr;
        }
        // Forza forward = (sin(yaw), cos(yaw)), right = (cos(yaw), -sin(yaw))
        const wx = p.PositionX + fwd * pSin + rgt * pCos;
        const wz = p.PositionZ + fwd * pCos - rgt * pSin;

        // Delta from current car center
        const dx = wx - cx;
        const dz = wz - cz;

        // Transform to current car-local frame
        const localFwd = dx * curSin + dz * curCos;
        const localRight = dx * curCos - dz * curSin;

        // Scale only the distance from car center, preserve wheel offset at endpoints
        // Split into car-center path (scaled) + wheel offset (unscaled)
        const cdx = p.PositionX - cx;
        const cdz = p.PositionZ - cz;
        const centerFwd = (cdx * curSin + cdz * curCos) * scale;
        const centerRight = (cdx * curCos - cdz * curSin) * scale;

        // Add unscaled wheel offset in car-local frame
        points.push([centerFwd + wheelOffX, -0.42, centerRight + wheelOffZ]);
        colors.push(slipColorObj(slips[w](p)));
      }

      wheelTrails.push({ points, colors });
    }

    return wheelTrails;
  }, [telemetry, cursorIdx]);

  if (!trails) return null;

  return (
    <>
      {trails.map((trail, w) =>
        trail.points.length > 1 ? (
          <Line
            key={`trail-${w}`}
            points={trail.points}
            vertexColors={trail.colors}
            lineWidth={3}
          />
        ) : null
      )}
    </>
  );
}

// ── Main scene (receives packet as prop) ───────────────────────────

function TrackOutline({
  outline,
  packet,
}: {
  outline: { x: number; z: number }[];
  packet: TelemetryPacket;
}) {
  // Pre-compute downsampled outline once (max 1500 points)
  const sampledOutline = useMemo(() => {
    const step = Math.max(1, Math.floor(outline.length / 1500));
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < outline.length; i += step) pts.push(outline[i]);
    return pts;
  }, [outline]);

  // Transform to car-local on cursor change
  const points = useMemo(() => {
    const cx = packet.PositionX;
    const cz = packet.PositionZ;
    const yaw = packet.Yaw;
    const curSin = Math.sin(yaw);
    const curCos = Math.cos(yaw);

    const pts: [number, number, number][] = [];
    for (let i = 0; i < sampledOutline.length; i++) {
      const dx = sampledOutline[i].x - cx;
      const dz = sampledOutline[i].z - cz;
      const localFwd = dx * curSin + dz * curCos;
      const localRight = dx * curCos - dz * curSin;
      pts.push([localFwd, -0.44, localRight]);
    }
    if (pts.length > 2) pts.push(pts[0]);
    return pts;
  }, [sampledOutline, packet.PositionX, packet.PositionZ, packet.Yaw]);

  if (points.length < 3) return null;

  return (
    <Line
      points={points}
      color="#3b6b9e"
      lineWidth={3}
      opacity={0.6}
      transparent
    />
  );
}

function CarScene({ packet, telemetry, cursorIdx, outline, solid }: { packet: TelemetryPacket; telemetry: TelemetryPacket[]; cursorIdx: number; outline: { x: number; z: number }[] | null; solid: boolean }) {
  const carGroupRef = useRef<THREE.Group>(null);
  const prevTimeRef = useRef(packet.TimestampMS);
  const spinAngles = useRef([0, 0, 0, 0]);

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

  useFrame(() => {
    if (!carGroupRef.current) return;
    carGroupRef.current.position.y = bodyDrop;
    carGroupRef.current.rotation.set(
      bodyRoll,
      0,
      bodyPitch,
      "YXZ"
    );
  });

  // Accumulate wheel spin based on telemetry time delta (not real time)
  const dt = (packet.TimestampMS - prevTimeRef.current) / 1000;
  prevTimeRef.current = packet.TimestampMS;
  const speeds = [
    packet.WheelRotationSpeedFL,
    packet.WheelRotationSpeedFR,
    packet.WheelRotationSpeedRL,
    packet.WheelRotationSpeedRR,
  ];
  for (let i = 0; i < 4; i++) {
    spinAngles.current[i] += speeds[i] * dt * 0.3;
  }

  const steerRad = (packet.Steer / 127) * 0.35;

  const wheelData = [
    { pos: [1.35, 0, -0.83] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFL, slip: Math.abs(packet.TireCombinedSlipFL), temp: packet.TireTempFL },
    { pos: [1.35, 0, 0.83] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFR, slip: Math.abs(packet.TireCombinedSlipFR), temp: packet.TireTempFR },
    { pos: [-1.35, 0, -0.81] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRL, slip: Math.abs(packet.TireCombinedSlipRL), temp: packet.TireTempRL },
    { pos: [-1.35, 0, 0.81] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRR, slip: Math.abs(packet.TireCombinedSlipRR), temp: packet.TireTempRR },
  ];

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.5} />

      {/* Ground grid — scrolls with car movement */}
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

      {/* Body — rolls with pitch/roll */}
      <group ref={carGroupRef}>
        <CarBody solid={solid} />
      </group>

      {/* Running gear — positioned by suspension */}
      <group>
        {/* Wheels */}
        {wheelData.map((w, i) => (
          <Wheel
            key={i}
            position={w.pos}
            steerAngle={w.steer}
            gripColor={tractionColor(w.slip)}
            tempColor={tireTempColor(w.temp)}
            spinAngle={spinAngles.current[i]}
          />
        ))}

        {/* Suspension springs — connect dropped body to grounded wheels */}
        {wheelData.map((w, i) => {
          const inboardZ = w.pos[2] > 0 ? w.pos[2] - 0.35 : w.pos[2] + 0.35;
          return (
            <SuspensionSpring
              key={`susp-${i}`}
              bodyPos={[w.pos[0], 0.23 + bodyDrop, inboardZ]}
              wheelPos={[w.pos[0], 0, inboardZ]}
              suspTravel={w.susp}
            />
          );
        })}

        {/* Front axle — fixed at ground level */}
        <Line
          points={[[1.35, 0, -0.83], [1.35, 0, 0.83]]}
          color="#64748b"
          lineWidth={2}
        />
        {/* Rear axle */}
        <Line
          points={[[-1.35, 0, -0.81], [-1.35, 0, 0.81]]}
          color="#64748b"
          lineWidth={2}
        />
        {/* Driveshaft */}
        <Line
          points={[[1.35, 0, 0], [-1.35, 0, 0]]}
          color="#94a3b8"
          lineWidth={1.5}
        />
        {/* Differential housings */}
        <mesh position={[1.35, 0, 0]}>
          <boxGeometry args={[0.15, 0.12, 0.2]} />
          <meshBasicMaterial color="#64748b" wireframe />
        </mesh>
        <mesh position={[-1.35, 0, 0]}>
          <boxGeometry args={[0.15, 0.12, 0.2]} />
          <meshBasicMaterial color="#64748b" wireframe />
        </mesh>
      </group>

      {/* Track outline (subtle) */}
      {outline && <TrackOutline outline={outline} packet={packet} />}

      {/* Tire trails (last 2s, colored by slip) */}
      <TireTrails telemetry={telemetry} cursorIdx={cursorIdx} />

      {/* Camera controls */}
      <OrbitControls
        enablePan={false}
        enableZoom={true}
        minDistance={3}
        maxDistance={2000}
        minPolarAngle={0.3}
        maxPolarAngle={Math.PI / 2 - 0.1}
      />
    </>
  );
}

// ── Exported wrapper ───────────────────────────────────────────────

export function CarWireframe({
  packet,
  telemetry,
  cursorIdx,
  outline,
}: {
  packet: TelemetryPacket;
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
}) {
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const [solid, setSolid] = useState(false);

  return (
    <div className="w-full h-full relative flex-1">
      <Canvas
        camera={{ position: [4, 2.5, 4], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CarScene packet={packet} telemetry={telemetry} cursorIdx={cursorIdx} outline={outline} solid={solid} />
      </Canvas>

      {/* Solid shell toggle */}
      <button
        onClick={() => setSolid((s) => !s)}
        className={`absolute top-2 left-2 px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
          solid
            ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
            : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
        }`}
      >
        {solid ? "Solid" : "Wire"}
      </button>

      {/* Throttle / Brake overlay */}
      <div className="absolute bottom-2 right-2 flex gap-1 items-end" style={{ height: 60 }}>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] font-mono text-emerald-400 font-bold tabular-nums">{throttlePct.toFixed(0)}</span>
          <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 44 }}>
            <div className="absolute bottom-0 w-full bg-emerald-400 rounded-sm transition-all" style={{ height: `${throttlePct}%` }} />
          </div>
          <span className="text-[7px] text-app-text-muted">T</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] font-mono text-red-400 font-bold tabular-nums">{brakePct.toFixed(0)}</span>
          <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 44 }}>
            <div className="absolute bottom-0 w-full bg-red-500 rounded-sm transition-all" style={{ height: `${brakePct}%` }} />
          </div>
          <span className="text-[7px] text-app-text-muted">B</span>
        </div>
      </div>
    </div>
  );
}
