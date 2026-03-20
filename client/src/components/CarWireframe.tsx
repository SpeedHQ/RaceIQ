import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, Edges, Line } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";

// ── Tire temp → color ──────────────────────────────────────────────

function tireTempColor(temp: number): string {
  if (temp < 80) return "#3b82f6";
  if (temp < 100) return "#34d399";
  if (temp < 120) return "#fbbf24";
  return "#ef4444";
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

function Wheel({
  position,
  steerAngle,
  suspTravel,
  color,
  spinAngle,
}: {
  position: [number, number, number];
  steerAngle: number;
  suspTravel: number;
  color: string;
  spinAngle: number;
}) {
  const wheelY = position[1] + suspY(suspTravel);
  const { tire, rim, hub } = useWheelGeometries();

  // Geometries are pre-rotated so axle = Z. Spin around Z only. No nesting.
  return (
    <group position={[position[0], wheelY, position[2]]}>
      <group rotation={[0, steerAngle, 0]}>
        <group rotation={[0, 0, spinAngle]}>
          <mesh geometry={tire}>
            <meshBasicMaterial color={color} wireframe />
          </mesh>
          <mesh geometry={rim}>
            <meshBasicMaterial color="#64748b" wireframe />
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
  const wheelY = wheelPos[1] + suspY(suspTravel);

  const coilRadius = 0.08;
  const coils = 6;
  const segments = coils * 12;
  const topY = bodyPos[1];
  const botY = wheelY;
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

function CarBody() {
  // Race car shaped body using a custom geometry
  const shape = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    // Define a low-slung race car shape
    const hw = 0.95; // half width
    const fhw = 0.78; // front half width (narrower)
    const hl = 2.2;  // half length
    const nl = 2.7;  // nose length
    const bh = 0.35; // body height
    const rh = bh * 0.55; // roof at nose

    // Vertices: floor (0-4), roof (5-9)
    const vertices = new Float32Array([
      // Floor
      -hl, 0, -hw,     // 0 - rear left
      -hl, 0, hw,      // 1 - rear right
       hl, 0, fhw,     // 2 - front right
       hl, 0, -fhw,    // 3 - front left
       nl, 0, 0,       // 4 - nose floor
      // Roof
      -hl, bh, -hw,    // 5 - rear left top
      -hl, bh, hw,     // 6 - rear right top
       hl, bh, fhw,    // 7 - front right top
       hl, bh, -fhw,   // 8 - front left top
       nl, rh, 0,      // 9 - nose top
      // Rear wing posts
      -hl - 0.15, bh + 0.45, -hw + 0.15,   // 10
      -hl - 0.15, bh + 0.45, hw - 0.15,    // 11
      // Rear wing ends
      -hl - 0.35, bh + 0.45, -hw + 0.05,   // 12
      -hl - 0.35, bh + 0.45, hw - 0.05,    // 13
    ]);

    const indices = [
      // Floor
      0, 1, 1, 2, 2, 3, 3, 0, 2, 4, 3, 4,
      // Roof
      5, 6, 6, 7, 7, 8, 8, 5, 7, 9, 8, 9,
      // Pillars
      0, 5, 1, 6, 2, 7, 3, 8, 4, 9,
      // Rear wing
      5, 10, 6, 11, 10, 11, 10, 12, 11, 13, 12, 13,
    ];

    geo.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    return geo;
  }, []);

  return (
    <lineSegments geometry={shape}>
      <lineBasicMaterial color="#94a3b8" opacity={0.7} transparent />
    </lineSegments>
  );
}

// ── Tire trail (last 2s, colored by slip) ──────────────────────────

// Wheel offsets from car center (local space)
const WHEEL_OFFSETS: [number, number][] = [
  [1.6, -1.05],   // FL: x, z
  [1.6, 1.05],    // FR
  [-1.6, -1.05],  // RL
  [-1.6, 1.05],   // RR
];

function slipColor(slip: number): string {
  if (slip < 0.3) return "#34d399";   // grip - green
  if (slip < 0.8) return "#fbbf24";   // sliding - amber
  return "#ef4444";                     // spinning - red
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
    const trailMs = 2000;

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

      for (let i = startIdx; i <= cursorIdx; i += 3) { // sample every 3rd for perf
        const p = telemetry[i];
        // Car center world position delta
        const dx = p.PositionX - cx;
        const dz = p.PositionZ - cz;

        // Transform world delta to car-local frame
        // forward = dx*sin(yaw) + dz*cos(yaw), right = dx*cos(yaw) - dz*sin(yaw)
        const localFwd = (dx * curSin + dz * curCos) * scale;
        const localRight = (dx * curCos - dz * curSin) * scale;

        // Car-local → scene: forward = +X, right = +Z
        points.push([localFwd, -0.42, localRight]);
        colors.push(slipColor(slips[w](p)));
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
            vertexColors={trail.colors.map((c) => new THREE.Color(c))}
            lineWidth={3}
          />
        ) : null
      )}
    </>
  );
}

// ── Main scene (receives packet as prop) ───────────────────────────

function CarScene({ packet, telemetry, cursorIdx }: { packet: TelemetryPacket; telemetry: TelemetryPacket[]; cursorIdx: number }) {
  const carGroupRef = useRef<THREE.Group>(null);
  const prevTimeRef = useRef(packet.TimestampMS);
  const spinAngles = useRef([0, 0, 0, 0]);

  // Derive body roll/pitch from suspension deltas (not raw telemetry which includes track gradient)
  // Higher suspension travel = more compressed on that corner
  const suspFL = packet.NormSuspensionTravelFL;
  const suspFR = packet.NormSuspensionTravelFR;
  const suspRL = packet.NormSuspensionTravelRL;
  const suspRR = packet.NormSuspensionTravelRR;

  // Roll: left more compressed than right = body leans left (negative X rotation)
  const leftAvg = (suspFL + suspRL) / 2;
  const rightAvg = (suspFR + suspRR) / 2;
  const bodyRoll = (rightAvg - leftAvg) * 0.3; // scale to reasonable visual angle

  // Pitch: front more compressed than rear = nose dives (positive Z rotation)
  const frontAvg = (suspFL + suspFR) / 2;
  const rearAvg = (suspRL + suspRR) / 2;
  const bodyPitch = (frontAvg - rearAvg) * 0.3;

  // Trail is in car-local frame (+X = forward), so car group doesn't need yaw
  // But body needs roll/pitch from suspension

  useFrame(() => {
    if (!carGroupRef.current) return;
    carGroupRef.current.rotation.set(
      bodyRoll,   // X = roll derived from suspension
      0,          // no yaw on body (trail is in car-local frame)
      bodyPitch,  // Z = pitch derived from suspension
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
    { pos: [1.6, 0, -1.05] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFL, temp: packet.TireTempFL },
    { pos: [1.6, 0, 1.05] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFR, temp: packet.TireTempFR },
    { pos: [-1.6, 0, -1.05] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRL, temp: packet.TireTempRL },
    { pos: [-1.6, 0, 1.05] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRR, temp: packet.TireTempRR },
  ];

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.5} />

      {/* Ground grid */}
      <Grid
        args={[10, 10]}
        position={[0, -0.45, 0]}
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
        <CarBody />
      </group>

      {/* Running gear — positioned by suspension */}
      <group>
        {/* Wheels */}
        {wheelData.map((w, i) => (
          <Wheel
            key={i}
            position={w.pos}
            steerAngle={w.steer}
            suspTravel={w.susp}
            color={tireTempColor(w.temp)}
            spinAngle={spinAngles.current[i]}
          />
        ))}

        {/* Suspension springs — connect rolled body to grounded wheels */}
        {wheelData.map((w, i) => {
          const inboardZ = w.pos[2] > 0 ? w.pos[2] - 0.45 : w.pos[2] + 0.45;
          return (
            <SuspensionSpring
              key={`susp-${i}`}
              bodyPos={[w.pos[0], 0.35, inboardZ]}
              wheelPos={[w.pos[0], w.pos[1], inboardZ]}
              suspTravel={w.susp}
            />
          );
        })}

        {/* Front axle — follows wheel suspension positions */}
        <Line
          points={[
            [1.6, suspY(wheelData[0].susp), -1.05],
            [1.6, suspY(wheelData[1].susp), 1.05],
          ]}
          color="#64748b"
          lineWidth={2}
        />
        {/* Rear axle */}
        <Line
          points={[
            [-1.6, suspY(wheelData[2].susp), -1.05],
            [-1.6, suspY(wheelData[3].susp), 1.05],
          ]}
          color="#64748b"
          lineWidth={2}
        />
        {/* Driveshaft */}
        <Line
          points={[
            [1.6, (suspY(wheelData[0].susp) + suspY(wheelData[1].susp)) / 2, 0],
            [-1.6, (suspY(wheelData[2].susp) + suspY(wheelData[3].susp)) / 2, 0],
          ]}
          color="#94a3b8"
          lineWidth={1.5}
        />
        {/* Differential housings */}
        <mesh position={[1.6, (suspY(wheelData[0].susp) + suspY(wheelData[1].susp)) / 2, 0]}>
          <boxGeometry args={[0.15, 0.12, 0.2]} />
          <meshBasicMaterial color="#64748b" wireframe />
        </mesh>
        <mesh position={[-1.6, (suspY(wheelData[2].susp) + suspY(wheelData[3].susp)) / 2, 0]}>
          <boxGeometry args={[0.15, 0.12, 0.2]} />
          <meshBasicMaterial color="#64748b" wireframe />
        </mesh>
      </group>

      {/* Tire trails (last 2s, colored by slip) */}
      <TireTrails telemetry={telemetry} cursorIdx={cursorIdx} />

      {/* Camera controls */}
      <OrbitControls
        enablePan={false}
        enableZoom={true}
        minDistance={3}
        maxDistance={12}
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
}: {
  packet: TelemetryPacket;
  telemetry: TelemetryPacket[];
  cursorIdx: number;
}) {
  return (
    <div className="w-full" style={{ height: 260 }}>
      <Canvas
        camera={{ position: [4, 2.5, 4], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CarScene packet={packet} telemetry={telemetry} cursorIdx={cursorIdx} />
      </Canvas>
    </div>
  );
}
