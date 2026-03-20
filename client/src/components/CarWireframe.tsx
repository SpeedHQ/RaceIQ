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
    // Default: torus ring in XZ plane, hole along Y; cylinder axis along Y.
    // rotateX(PI/2) stands them upright: hole/axle along Z (car lateral).
    const tire = new THREE.TorusGeometry(0.28, 0.06, 6, 16);
    tire.rotateX(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8, 1, true);
    rim.rotateX(Math.PI / 2);
    const hub = new THREE.CircleGeometry(0.22, 5);
    hub.rotateX(Math.PI / 2);
    return { tire, rim, hub };
  }, []);

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
  const suspOffset = (suspTravel - 0.5) * 0.3;
  const wheelY = position[1] + suspOffset;
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

// ── Suspension strut (dashed line from body to wheel) ──────────────

function SuspensionStrut({
  bodyPos,
  wheelPos,
  suspTravel,
}: {
  bodyPos: [number, number, number];
  wheelPos: [number, number, number];
  suspTravel: number;
}) {
  const suspOffset = (suspTravel - 0.5) * 0.3;
  const endY = wheelPos[1] + suspOffset;

  return (
    <Line
      points={[bodyPos, [wheelPos[0], endY, wheelPos[2]]]}
      color="#475569"
      lineWidth={1}
      dashed
      dashSize={0.08}
      gapSize={0.06}
    />
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

// ── Main scene (receives packet as prop) ───────────────────────────

function CarScene({ packet }: { packet: TelemetryPacket }) {
  const carGroupRef = useRef<THREE.Group>(null);
  const prevTimeRef = useRef(packet.TimestampMS);
  const spinAngles = useRef([0, 0, 0, 0]);

  // Update car rotation every frame from telemetry
  useFrame(() => {
    if (!carGroupRef.current) return;
    carGroupRef.current.rotation.set(
      packet.Pitch,
      0,
      packet.Roll,
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

      {/* Car group — rotated by pitch/roll */}
      <group ref={carGroupRef}>
        <CarBody />

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

        {/* Suspension struts */}
        {wheelData.map((w, i) => (
          <SuspensionStrut
            key={`susp-${i}`}
            bodyPos={[w.pos[0], 0, w.pos[2]]}
            wheelPos={w.pos}
            suspTravel={w.susp}
          />
        ))}
      </group>

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

export function CarWireframe({ packet }: { packet: TelemetryPacket }) {
  return (
    <div className="w-full" style={{ height: 260 }}>
      <Canvas
        camera={{ position: [4, 2.5, 4], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CarScene packet={packet} />
      </Canvas>
    </div>
  );
}
