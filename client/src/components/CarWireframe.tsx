import { useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Line, useGLTF } from "@react-three/drei";
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
    const tire = new THREE.CylinderGeometry(0.34, 0.34, 0.30, 16, 1, false);
    tire.rotateX(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.23, 0.23, 0.24, 8, 1, true);
    rim.rotateX(Math.PI / 2);
    const hub = new THREE.CircleGeometry(0.23, 5);
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

// ── Car body (loaded GLB model) ────────────────────────────────────
// "Aston Martin Vantage GT3" (https://skfb.ly/p8vWx) by Design Studio Poland
// Licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/)

const MODEL_PATH = "/models/aston_martin_vantage_gt3.glb";

function CarBody({ solid }: { solid: boolean }) {
  const { scene } = useGLTF(MODEL_PATH);

  // Log model structure on first load to find the right nodes
  useMemo(() => {
    const names: string[] = [];
    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        const box = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        box.getSize(size);
        names.push(`${child.name} [${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}]`);
      }
    });
    console.log("GLB meshes:", names);
    // Also log overall bounding box
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    console.log("GLB total size:", size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2));
    console.log("GLB center:", center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2));
  }, [scene]);

  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (solid) {
          mesh.material = new THREE.MeshBasicMaterial({
            color: "#1a2332",
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
          });
        } else {
          mesh.material = new THREE.MeshBasicMaterial({
            color: "#94a3b8",
            wireframe: true,
            transparent: true,
            opacity: 0.03,
          });
        }
      }
    });
    return clone;
  }, [scene, solid]);

  // Auto-scale based on bounding box to fit our coordinate system (~4.7m long)
  const { scale: autoScale, offset } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const s = 4.7 / maxDim; // normalize to ~4.7m (GT3 length)
    return { scale: s, offset: center.multiplyScalar(-s) };
  }, [scene]);

  return (
    <group scale={autoScale} position={[offset.x, offset.y + 0.25, offset.z]} rotation={[0, 0, 0]}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload(MODEL_PATH);

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
const BRAKE_RED = new THREE.Color("#cc3300");
const BRAKE_ORANGE = new THREE.Color("#ff6600");

function slipColor(slip: number): string {
  if (slip < 0.3) return "#34d399";
  if (slip < 0.8) return "#fbbf24";
  return "#ef4444";
}

function trailColorObj(slip: number, brake: number): THREE.Color {
  // Braking overrides slip color with brake trail
  if (brake > 50) return BRAKE_RED;
  if (brake > 10) return BRAKE_ORANGE;
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
        colors.push(trailColorObj(slips[w](p), 0));
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

// ── Brake trail (separate line at tail light height) ───────────────

function BrakeTrail({
  telemetry,
  cursorIdx,
}: {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
}) {
  const trail = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return null;

    const curTime = cur.TimestampMS;
    let startIdx = cursorIdx;
    while (startIdx > 0 && curTime - telemetry[startIdx].TimestampMS < 800) {
      startIdx--;
    }
    if (cursorIdx - startIdx < 2) return null;

    const cx = cur.PositionX;
    const cz = cur.PositionZ;
    const cyaw = cur.Yaw;
    const curSin = Math.sin(cyaw);
    const curCos = Math.cos(cyaw);
    const scale = 0.06;

    // Two brake light positions (left z=-0.70, right z=0.70)
    const lights: { points: [number, number, number][]; colors: THREE.Color[] }[] = [];

    for (const lightZ of [-0.70, 0.70]) {
      const points: [number, number, number][] = [];
      const colors: THREE.Color[] = [];

      for (let i = startIdx; i <= cursorIdx; i += 5) {
        const p = telemetry[i];
        if (p.Brake < 10) continue; // only draw when braking

        const cdx = p.PositionX - cx;
        const cdz = p.PositionZ - cz;
        const centerFwd = (cdx * curSin + cdz * curCos) * scale;
        const centerRight = (cdx * curCos - cdz * curSin) * scale;

        // Position at rear of car + light offset, at tail light height
        points.push([centerFwd + (-2.01), 0.22, centerRight + lightZ]);
        colors.push(p.Brake > 50 ? BRAKE_RED : BRAKE_ORANGE);
      }

      if (points.length > 1) lights.push({ points, colors });
    }

    return lights;
  }, [telemetry, cursorIdx]);

  if (!trail || trail.length === 0) return null;

  return (
    <>
      {trail.map((t, i) => (
        <Line
          key={`brake-${i}`}
          points={t.points}
          vertexColors={t.colors}
          lineWidth={4}
        />
      ))}
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

  const steerRad = -(packet.Steer / 127) * 0.35;

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

      {/* Tire trails (ground, colored by slip) */}
      <TireTrails telemetry={telemetry} cursorIdx={cursorIdx} />

      {/* Brake trail (tail light height, only when braking) */}
      <BrakeTrail telemetry={telemetry} cursorIdx={cursorIdx} />

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
