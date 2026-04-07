import React, { useRef, useMemo, useState, useCallback, useEffect, Suspense } from "react";
import { client } from "../lib/rpc";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, Line, useGLTF } from "@react-three/drei";
// @ts-ignore
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import { getCarModel, loadCarModelConfigs, F1_CAR, DEMO_CAR, type CarModelEnrichment } from "../data/car-models";
import { allWheelStates } from "../lib/vehicle-dynamics";
import { useUnits } from "../hooks/useUnits";
import { useSettings } from "../hooks/queries";
import { useGameId } from "../stores/game";
import { useLocalStorage } from "../hooks/useLocalStorage";

// ── Tire temp → color ──────────────────────────────────────────────

function tractionColor(slip: number, gameId?: string): string {
  // F1/ACC slip values are radians (0.01-0.1), Forza uses unitless (0-2+)
  const isSmallScale = gameId === "f1-2025" || gameId === "acc";
  const warn = isSmallScale ? 0.03 : 0.3;
  const crit = isSmallScale ? 0.08 : 0.8;
  if (slip < warn) return "#34d399";    // full grip — green
  if (slip < crit) return "#fbbf24";    // sliding — amber
  return "#ef4444";                     // loss of traction — red
}

// ── Wheel component ────────────────────────────────────────────────

// Pre-rotated geometries — baked orientation, no runtime Euler nesting
function makeWheelGeometries(radius: number, width: number) {
  const rimRadius = radius * 0.67;
  // rotateX(PI/2) stands geometries upright: axis Y → Z (car lateral axle).
  const tire = new THREE.CylinderGeometry(radius, radius, width, 16, 1, false);
  tire.rotateX(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(rimRadius, rimRadius, width * 0.8, 8, 1, true);
  rim.rotateX(Math.PI / 2);
  const hub = new THREE.CircleGeometry(rimRadius, 5);
  hub.rotateX(Math.PI / 2);
  return { tire, rim, hub };
}

const useWheelGeometries = (radius = 0.34, width = 0.30) =>
  useMemo(() => makeWheelGeometries(radius, width), [radius, width]);

// Forza tire temps are in °F: <150 cold, 150-170 warming, 170-220 optimal, 220-250 hot, >250 overheating
function tireTempColor(temp: number): string {
  if (temp < 150) return "#3b82f6";
  if (temp < 170) return "#22d3ee";
  if (temp < 220) return "#34d399";
  if (temp < 250) return "#fbbf24";
  return "#ef4444";
}

function tempToColor(t: number): string {
  if (t < 150) return "#3b82f6";
  if (t < 170) return "#22d3ee";
  if (t < 220) return "#34d399";
  if (t < 250) return "#fbbf24";
  return "#ef4444";
}

function TempLabel({ displayTemp, rawTemp, side }: { displayTemp: string; rawTemp: number; side: "left" | "right" }) {
  const color = tempToColor(rawTemp);
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    ctx.font = "bold 30px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(displayTemp, 64, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [displayTemp, color]);

  return (
    <sprite position={[0, 0.5, side === "left" ? -0.55 : 0.55]} scale={[0.6, 0.22, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function WearLabel({ wearRate, side }: { wearRate: number; side: "left" | "right" }) {
  const text = wearRate > 0.0001 ? `-${(wearRate * 100).toFixed(2)}%/s` : "";
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f97316";
    ctx.fillText(text, 64, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text]);

  return (
    <sprite position={[0, 0.22, side === "left" ? -0.55 : 0.55]} scale={[0.6, 0.22, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function BrakeTempLabel({ temp, side }: { temp: number; side: "left" | "right" }) {
  const color = brakeTempColor(temp);
  const text = `${temp.toFixed(0)}°C`;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 160, 48);
    // Brake disc icon — rotor with caliper
    const ix = 20, iy = 24, r = 11;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    // Outer disc
    ctx.beginPath();
    ctx.arc(ix, iy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Inner hub
    ctx.beginPath();
    ctx.arc(ix, iy, 4, 0, Math.PI * 2);
    ctx.stroke();
    // Ventilation slots (6 radial lines)
    for (let a = 0; a < 6; a++) {
      const angle = (a / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(ix + Math.cos(angle) * 5, iy + Math.sin(angle) * 5);
      ctx.lineTo(ix + Math.cos(angle) * 9, iy + Math.sin(angle) * 9);
      ctx.stroke();
    }
    // Caliper (thick arc on one side)
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(ix, iy, r + 2, -0.6, 0.6);
    ctx.stroke();
    // Temp text
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 96, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={[0, 0.08, side === "left" ? -0.55 : 0.55]} scale={[0.5, 0.18, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function HealthLabel({ wear, side }: { wear: number; side: "left" | "right" }) {
  const health = 1 - wear;
  const pct = (health * 100).toFixed(0);
  const color = health > 0.7 ? "#34d399" : health > 0.4 ? "#fbbf24" : "#ef4444";
  const text = `${pct}% H`;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    ctx.font = "bold 26px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 64, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={[0, 0.36, side === "left" ? -0.55 : 0.55]} scale={[0.5, 0.18, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function brakeTempColor(temp: number): string {
  if (temp < 200) return "#3b82f6";  // cold — blue
  if (temp < 400) return "#6ee7b7";  // warming — green
  if (temp < 700) return "#fbbf24";  // optimal — amber
  if (temp < 900) return "#f97316";  // hot — orange
  return "#ef4444";                   // critical — red
}

function Wheel({
  position,
  steerAngle,
  gripColor,
  tempColor,
  rotationSpeed,
  temp,
  displayTemp,
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
  tempColor: string;
  rotationSpeed: number;
  temp: number;
  displayTemp: string;
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
            <meshBasicMaterial color={tempColor} transparent opacity={0.85} side={THREE.DoubleSide} />
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
      {temp > 0 && (
        <>
          <TempLabel displayTemp={displayTemp} rawTemp={temp} side={side} />
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

// ── Suspension spring (coil + damper) ──────────────────────────────

const SUSP_HEX_COLORS = ["#3b82f6", "#34d399", "#facc15", "#ef4444"];

function suspHexColor(suspTravel: number, thresholds: number[]): string {
  const pct = suspTravel * 100;
  for (let i = 0; i < thresholds.length; i++) {
    if (pct < thresholds[i]) return SUSP_HEX_COLORS[i] ?? SUSP_HEX_COLORS[0];
  }
  return SUSP_HEX_COLORS[thresholds.length] ?? SUSP_HEX_COLORS[SUSP_HEX_COLORS.length - 1];
}

function SuspensionSpring({
  bodyPos,
  wheelPos,
  suspTravel,
  suspThresholds,
}: {
  bodyPos: [number, number, number];
  wheelPos: [number, number, number];
  suspTravel: number;
  suspThresholds: number[];
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

  const color = suspHexColor(suspTravel, suspThresholds);

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

// Default hidden meshes for the bundled Aston Martin model
export const DEFAULT_HIDDEN_MESHES = new Set([
  94, 125, 126, 161, 183, 184, 211, 212, 214, 215, 217, 219,
  119, 120, 122, 123, 174, 175, 177, 178,
  7, 8,
]);

/**
 * Determine what action to take for a mesh given current display mode.
 * Returns "remove" | "solid" | "wire" to indicate the mesh treatment.
 */
export function classifyMesh(
  meshName: string,
  solid: "wire" | "solid" | "hidden",
  hideModelWheels: boolean,
  customHiddenMeshes?: number[],
): "remove" | "solid" | "wire" {
  const hiddenMeshes = customHiddenMeshes?.length ? new Set(customHiddenMeshes) : DEFAULT_HIDDEN_MESHES;
  const num = parseInt(meshName.replace(/\D/g, ""), 10);
  const isWheelMesh = hiddenMeshes.has(num);

  if (solid === "hidden") return "remove";
  if (isWheelMesh && (solid === "solid" || hideModelWheels)) return "remove";
  if (solid === "solid") return "solid";
  return "wire";
}

function CarBody({ solid, carModel, modelOffsetX, hideModelWheels }: { solid: "wire" | "solid" | "hidden"; carModel: CarModelEnrichment & { hasModel: boolean }; modelOffsetX: number; hideModelWheels?: boolean }) {
  const { scene } = useGLTF(carModel.modelPath);


  const model = useMemo(() => {
    const clone = scene.clone(true);
    const toRemove: THREE.Object3D[] = [];
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const action = classifyMesh(mesh.name, solid, !!hideModelWheels, carModel.solidHiddenMeshes);

        if (action === "remove") {
          toRemove.push(mesh);
        } else if (action === "solid") {
          mesh.material = new THREE.MeshStandardMaterial({
            color: "#4a6a8a",
            metalness: 0.7,
            roughness: 0.25,
            side: THREE.DoubleSide,
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
    toRemove.forEach((obj) => obj.parent?.remove(obj));
    return clone;
  }, [scene, solid, hideModelWheels, carModel]);

  // Scale GLB to match our coordinate system.
  // If glbWheelbase is set, scale so it matches our wheelbase exactly.
  // Otherwise fall back to scaling by body length.
  const { scale: autoScale, offset } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    let s: number;
    if (carModel.glbWheelbase) {
      s = (carModel.halfWheelbase * 2) / carModel.glbWheelbase;
    } else {
      const lengthDim = Math.max(size.x, size.y, size.z);
      s = carModel.bodyLength / lengthDim;
    }

    const off = center.multiplyScalar(-s);
    // When model is rotated, model-local X becomes sideways — only apply offset if no rotation
    if (!carModel.glbRotationY) off.x += modelOffsetX;
    return { scale: s, offset: off };
  }, [scene, carModel, modelOffsetX]);


  const [highlightedMesh, setHighlightedMesh] = useState<string | null>(null);

  const handleDoubleClick = useCallback((e: { stopPropagation?: () => void; object?: THREE.Mesh }) => {
    e.stopPropagation?.();
    const mesh = e.object as THREE.Mesh | undefined;
    if (!mesh?.isMesh) return;
    const num = parseInt(mesh.name.replace(/\D/g, ""), 10);
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    console.log(`[CarBody] Clicked: ${mesh.name} (#${num}) [${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}]`);

    if (highlightedMesh === mesh.name) {
      // Un-highlight: restore original material
      setHighlightedMesh(null);
    } else {
      setHighlightedMesh(mesh.name);
    }
  }, [highlightedMesh]);

  // Apply highlight overlay
  useEffect(() => {
    model.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.name === highlightedMesh) {
          mesh.material = new THREE.MeshBasicMaterial({ color: "#ff4444", wireframe: false, transparent: true, opacity: 0.6 });
        }
      }
    });
  }, [highlightedMesh, model]);

  return (
    <group rotation={[0, carModel.glbRotationY ?? 0, 0]}>
      <group scale={autoScale} position={[offset.x, offset.y + 0.25 + (carModel.glbOffsetY ?? 0), offset.z + (carModel.glbOffsetZ ?? 0)]}>
        <primitive object={model} onDoubleClick={handleDoubleClick} />
      </group>
    </group>
  );
}

useGLTF.preload("/models/aston_martin_vantage_gt3.glb");
useGLTF.preload("/models/f1_2025_mclaren_mcl39.glb");

// ── Tire trail (last 2s, colored by slip) ──────────────────────────

function getWheelOffsets(m: CarModelEnrichment): [number, number][] {
  return [
    [m.halfWheelbase, -m.halfFrontTrack],   // FL
    [m.halfWheelbase, m.halfFrontTrack],     // FR
    [-m.halfWheelbase, -m.halfRearTrack],    // RL
    [-m.halfWheelbase, m.halfRearTrack],     // RR
  ];
}

// Pre-allocated color objects to avoid GC pressure
const SLIP_GREEN = new THREE.Color("#34d399");
const SLIP_AMBER = new THREE.Color("#fbbf24");
const SLIP_RED = new THREE.Color("#ef4444");
const BRAKE_MIN = new THREE.Color("#ff9933");
const BRAKE_MAX = new THREE.Color("#cc0000");
const _brakeTemp = new THREE.Color();


function brakeColor(brake: number): THREE.Color {
  // Smooth lerp from light orange (10) to deep red (255)
  const t = Math.min(1, Math.max(0, (brake - 10) / 245));
  return _brakeTemp.copy(BRAKE_MIN).lerp(BRAKE_MAX, t).clone();
}

function trailColorObj(slip: number, brake: number, isSmallScale?: boolean): THREE.Color {
  // Braking overrides slip color with brake trail
  if (brake > 10) return brakeColor(brake);
  const warn = isSmallScale ? 0.03 : 0.3;
  const crit = isSmallScale ? 0.08 : 0.8;
  if (slip < warn) return SLIP_GREEN;
  if (slip < crit) return SLIP_AMBER;
  return SLIP_RED;
}

function TireTrails({
  telemetry,
  cursorIdx,
  carModel,
}: {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  carModel: CarModelEnrichment;
}) {
  const TRAIL_DURATION_MS = 80;
  const WHEEL_OFFSETS = useMemo(() => getWheelOffsets(carModel), [carModel]);

  // Compute slip colors on-demand (not pre-computed for all packets)
  const smallScale = telemetry[0]?.gameId === "f1-2025" || telemetry[0]?.gameId === "acc";
  const slipFns = [
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFL),
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFR),
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRL),
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRR),
  ];

  // Only recompute trail geometry on cursor change — use pre-computed colors
  const trails = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return null;
    // Find start index by time (consistent trail length regardless of packet rate)
    const curTime = cur.TimestampMS;
    let startIdx = cursorIdx;
    while (startIdx > 0 && curTime - telemetry[startIdx - 1].TimestampMS < TRAIL_DURATION_MS) startIdx--;
    if (cursorIdx - startIdx < 2) return null;

    const cx = cur.PositionX, cz = cur.PositionZ;
    const s = Math.sin(cur.Yaw), c = Math.cos(cur.Yaw);

    return WHEEL_OFFSETS.map((off, w) => {
      const pts = new Float32Array((cursorIdx - startIdx + 1) * 3);
      const cols: THREE.Color[] = [];
      for (let i = startIdx, j = 0; i <= cursorIdx; i++, j++) {
        const p = telemetry[i];
        const dx = p.PositionX - cx, dz = p.PositionZ - cz;
        pts[j * 3] = dx * s + dz * c + off[0];
        pts[j * 3 + 1] = -0.42;
        pts[j * 3 + 2] = dx * c - dz * s + off[1];
        cols.push(trailColorObj(slipFns[w](p), 0, smallScale));
      }
      return { pts, cols };
    });
  }, [telemetry, cursorIdx, WHEEL_OFFSETS]);

  if (!trails) return null;

  return (
    <>
      {trails.map((trail, w) => {
        const n = trail.cols.length;
        if (n < 2) return null;
        const points: [number, number, number][] = [];
        for (let i = 0; i < n; i++) points.push([trail.pts[i * 3], trail.pts[i * 3 + 1], trail.pts[i * 3 + 2]]);
        return (
          <Line key={`trail-${w}`} points={points} vertexColors={trail.cols as unknown as Array<[number, number, number]>} lineWidth={3} />
        );
      })}
    </>
  );
}


// ── Throttle/Brake input overlay (two lines beside driving line) ────

const THROTTLE_COLOR = new THREE.Color("#34d399").convertSRGBToLinear();  // emerald-400 sRGB → linear
const BRAKE_COLOR = new THREE.Color("#ef4444").convertSRGBToLinear();     // red-500 sRGB → linear

function InputOverlay({
  telemetry,
  packet,
}: {
  telemetry: TelemetryPacket[];
  packet: TelemetryPacket;
}) {
  const data = useMemo(() => {
    const cx = packet.PositionX;
    const cz = packet.PositionZ;
    const yaw = packet.Yaw;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const Y = -0.33; // ground level
    const OFFSET = 0.05; // lateral offset from center in meters
    const AHEAD = 60;
    const BEHIND = 20;
    const maxDist2 = AHEAD * AHEAD;

    // Collect in-range points with their local coords and input values
    const pts: { fwd: number; lat: number; throttle: number; brake: number }[] = [];
    for (const p of telemetry) {
      const dx = p.PositionX - cx;
      const dz = p.PositionZ - cz;
      if (dx * dx + dz * dz > maxDist2) continue;
      const localFwd = dx * s + dz * c;
      const localLat = dx * c - dz * s;
      if (localFwd < -BEHIND || localFwd > AHEAD || Math.abs(localLat) > 30) continue;
      pts.push({ fwd: localFwd, lat: localLat, throttle: (p.Accel ?? 0) / 255, brake: (p.Brake ?? 0) / 255 });
    }

    // Compute perpendicular normals and build offset lines
    const throttlePts: [number, number, number][] = [];
    const throttleCols: THREE.Color[] = [];
    const brakePts: [number, number, number][] = [];
    const brakeCols: THREE.Color[] = [];

    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const tFwd = next.fwd - prev.fwd;
      const tLat = next.lat - prev.lat;
      const len = Math.sqrt(tFwd * tFwd + tLat * tLat) || 1;
      // Normal perpendicular to tangent (rotated 90°)
      const nFwd = -tLat / len;
      const nLat = tFwd / len;

      const p = pts[i];
      if (p.throttle > 0) {
        throttlePts.push([p.fwd + nFwd * OFFSET, Y, p.lat + nLat * OFFSET]);
        throttleCols.push(new THREE.Color(0, 0, 0).lerp(THROTTLE_COLOR, p.throttle));
      }
      if (p.brake > 0) {
        brakePts.push([p.fwd - nFwd * OFFSET, Y, p.lat - nLat * OFFSET]);
        brakeCols.push(new THREE.Color(0, 0, 0).lerp(BRAKE_COLOR, p.brake));
      }
    }

    return { throttlePts, throttleCols, brakePts, brakeCols };
  }, [telemetry, packet.PositionX, packet.PositionZ, packet.Yaw]);

  return (
    <>
      {data.throttlePts.length > 1 && (
        <Line points={data.throttlePts} vertexColors={data.throttleCols} lineWidth={3} transparent opacity={0.9} />
      )}
      {data.brakePts.length > 1 && (
        <Line points={data.brakePts} vertexColors={data.brakeCols} lineWidth={3} transparent opacity={0.9} />
      )}
    </>
  );
}

// ── Curb markers on track (world-space, full lap history) ───────────

function CurbMarkers({
  telemetry,
  packet,
  carModel,
}: {
  telemetry: TelemetryPacket[];
  cursorIdx?: number;
  packet: TelemetryPacket;
  carModel: CarModelEnrichment;
}) {
  // Wheel offsets in car-local frame: [forward, right] in meters
  // Forza world: forward = (sin(yaw), cos(yaw)), right = (cos(yaw), -sin(yaw))
  // Forza PositionX/Z is ~0.065m ahead of geometric center (measured from
  // front→rear curb entry timing vs extracted wheelbase), so shift wheels back
  const posOffset = 0.065;
  const wheelOffsets = useMemo(() => ({
    FL: { fwd: carModel.halfWheelbase - posOffset, rgt: -carModel.halfFrontTrack },
    FR: { fwd: carModel.halfWheelbase - posOffset, rgt: carModel.halfFrontTrack },
    RL: { fwd: -carModel.halfWheelbase - posOffset, rgt: -carModel.halfRearTrack },
    RR: { fwd: -carModel.halfWheelbase - posOffset, rgt: carModel.halfRearTrack },
  }), [carModel]);

  // Compute world-space wheel position
  const wheelWorld = (p: TelemetryPacket, off: { fwd: number; rgt: number }) => {
    const s = Math.sin(p.Yaw);
    const c = Math.cos(p.Yaw);
    return {
      x: p.PositionX + off.fwd * s + off.rgt * c,
      z: p.PositionZ + off.fwd * c - off.rgt * s,
    };
  };

  // Build world-space curb contact points per wheel from full telemetry
  const { leftCurb, rightCurb, puddlePoints } = useMemo(() => {
    const left: { x: number; z: number }[] = [];
    const right: { x: number; z: number }[] = [];
    const wet: { x: number; z: number }[] = [];

    // Scan full telemetry so curbs are visible ahead of car too
    for (let i = 0; i < telemetry.length; i++) {
      const p = telemetry[i];

      // Left-side curbs (FL, RL)
      if (p.WheelOnRumbleStripFL !== 0) left.push(wheelWorld(p, wheelOffsets.FL));
      if (p.WheelOnRumbleStripRL !== 0) left.push(wheelWorld(p, wheelOffsets.RL));

      // Right-side curbs (FR, RR)
      if (p.WheelOnRumbleStripFR !== 0) right.push(wheelWorld(p, wheelOffsets.FR));
      if (p.WheelOnRumbleStripRR !== 0) right.push(wheelWorld(p, wheelOffsets.RR));

      // Puddles — any wheel
      if (p.WheelInPuddleDepthFL > 0) wet.push(wheelWorld(p, wheelOffsets.FL));
      if (p.WheelInPuddleDepthFR > 0) wet.push(wheelWorld(p, wheelOffsets.FR));
      if (p.WheelInPuddleDepthRL > 0) wet.push(wheelWorld(p, wheelOffsets.RL));
      if (p.WheelInPuddleDepthRR > 0) wet.push(wheelWorld(p, wheelOffsets.RR));
    }

    return { leftCurb: left, rightCurb: right, puddlePoints: wet };
  }, [telemetry, wheelOffsets]);

  const cx = packet.PositionX;
  const cz = packet.PositionZ;
  const yaw = packet.Yaw;
  const GROUND_Y = -carModel.tireRadius;

  // Filter and transform world-space points to car-local scene coordinates
  const allCurb = useMemo(() => [...leftCurb, ...rightCurb], [leftCurb, rightCurb]);

  // Use filterByDistance (same as track outline) to get line segments, then flatten to individual points
  const curbSegs = useMemo(() => filterByDistance(allCurb, cx, cz, yaw, GROUND_Y), [allCurb, cx, cz, yaw]);
  const puddleSegs = useMemo(() => filterByDistance(puddlePoints, cx, cz, yaw, GROUND_Y), [puddlePoints, cx, cz, yaw]);

  // Flatten segments into individual points for rendering as dots
  const curbPts = useMemo(() => curbSegs.flatMap(seg => seg), [curbSegs]);
  const puddlePts = useMemo(() => puddleSegs.flatMap(seg => seg), [puddleSegs]);

  if (curbPts.length === 0 && puddlePts.length === 0) return null;

  return (
    <>
      {curbPts.map((pt, i) => (
        <mesh key={`c${i}`} position={pt}>
          <sphereGeometry args={[0.02, 6, 6]} />
          <meshBasicMaterial color="#ff8800" transparent opacity={0.9} />
        </mesh>
      ))}
      {puddlePts.map((pt, i) => (
        <mesh key={`p${i}`} position={pt}>
          <sphereGeometry args={[0.1, 6, 6]} />
          <meshBasicMaterial color="#3b82f6" transparent opacity={0.5} />
        </mesh>
      ))}
    </>
  );
}

// ── Main scene (receives packet as prop) ───────────────────────────

const DIST_AHEAD = 80;   // meters ahead of car
const DIST_BEHIND = 20;  // meters behind car
const DIST_LATERAL = 30; // meters to the side

/**
 * Filter world-space points by directional distance from car — shows more
 * track ahead than behind, based on car's forward direction.
 */
function filterByDistance(
  pts: { x: number; z: number }[],
  cx: number,
  cz: number,
  yaw: number,
  y: number,
  ahead = DIST_AHEAD,
  behind = DIST_BEHIND,
  lateral = DIST_LATERAL,
): [number, number, number][][] {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const segments: [number, number, number][][] = [];
  let current: [number, number, number][] = [];

  if (!Array.isArray(pts)) return [];
  for (const p of pts) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    // Transform to car-local: forward/lateral
    const localFwd = dx * s + dz * c;
    const localLat = dx * c - dz * s;
    const dist2 = dx * dx + dz * dz;
    const maxDist = ahead * ahead; // cap total straight-line distance
    const inRange = dist2 <= maxDist &&
                    localFwd >= -behind && localFwd <= ahead &&
                    Math.abs(localLat) <= lateral;
    if (inRange) {
      current.push([localFwd, y, localLat]);
    } else if (current.length > 1) {
      segments.push(current);
      current = [];
    } else {
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function TrackOutline({
  outline,
  packet,
  distAhead,
}: {
  outline: { x: number; z: number }[];
  packet: TelemetryPacket;
  distAhead?: number;
}) {
  const ahead = distAhead ?? DIST_AHEAD;
  const segments = useMemo(() =>
    filterByDistance(outline, packet.PositionX, packet.PositionZ, packet.Yaw, -0.44, ahead),
    [outline, packet.PositionX, packet.PositionZ, packet.Yaw, ahead]
  );

  if (segments.length === 0) return null;

  return (
    <>
      {segments.map((seg, i) => (
        <Line key={i} points={seg} color="#ffffff" lineWidth={3} opacity={0.6} transparent />
      ))}
    </>
  );
}

// ── Track boundary edges (3D) ────────────────────────────────────

function TrackBoundaryEdges({
  boundaries,
  packet,
  tireRadius,
  distAhead,
}: {
  boundaries: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[] };
  packet: TelemetryPacket;
  tireRadius?: number;
  distAhead?: number;
}) {
  const WALL_HEIGHT = 0.12;
  const GROUND_Y = -(tireRadius ?? 0.33);
  const ahead = distAhead ?? DIST_AHEAD;

  // Pre-compute full wall geometry once — filter by distance on cursor change
  const leftSegsGround = useMemo(() => filterByDistance(boundaries.leftEdge, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead), [boundaries.leftEdge, packet.PositionX, packet.PositionZ, packet.Yaw, ahead]);
  const rightSegsGround = useMemo(() => filterByDistance(boundaries.rightEdge, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead), [boundaries.rightEdge, packet.PositionX, packet.PositionZ, packet.Yaw, ahead]);

  // Build wall geometry from ground segments (extrude upward) — single pass
  const buildWalls = useCallback((segs: [number, number, number][][]): THREE.BufferGeometry | null => {
    const allPositions: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;
    for (const seg of segs) {
      if (seg.length < 2) continue;
      for (const pt of seg) {
        allPositions.push(pt[0], pt[1], pt[2]); // ground
        allPositions.push(pt[0], pt[1] + WALL_HEIGHT, pt[2]); // top
      }
      for (let i = 0; i < seg.length - 1; i++) {
        const b = vertexOffset + i * 2;
        allIndices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
      vertexOffset += seg.length * 2;
    }
    if (allPositions.length < 6) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(allPositions, 3));
    geom.setIndex(allIndices);
    return geom;
  }, []);

  const leftGeom = useMemo(() => buildWalls(leftSegsGround), [leftSegsGround, buildWalls]);
  const rightGeom = useMemo(() => buildWalls(rightSegsGround), [rightSegsGround, buildWalls]);

  if (!leftGeom && !rightGeom) return null;

  return (
    <>
      {leftGeom && <mesh geometry={leftGeom}><meshBasicMaterial color="#ef4444" opacity={0.5} transparent side={THREE.DoubleSide} /></mesh>}
      {rightGeom && <mesh geometry={rightGeom}><meshBasicMaterial color="#3b82f6" opacity={0.5} transparent side={THREE.DoubleSide} /></mesh>}
    </>
  );
}

// ── Dimension lines (measurement overlay) ───────────────────────

function DimensionLines({ carModel }: { carModel: CarModelEnrichment }) {
  const wb = carModel.halfWheelbase;
  const ft = carModel.halfFrontTrack;
  const rt = carModel.halfRearTrack;
  const y = -0.42;

  // Dimension line helper: line with end ticks and a center label
  return (
    <group>
      {/* Front track width */}
      <Line points={[[wb, y, -ft], [wb, y, ft]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[wb, y - 0.05, -ft], [wb, y + 0.05, -ft]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[wb, y - 0.05, ft], [wb, y + 0.05, ft]]} color="#22d3ee" lineWidth={2} />

      {/* Rear track width */}
      <Line points={[[-wb, y, -rt], [-wb, y, rt]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[-wb, y - 0.05, -rt], [-wb, y + 0.05, -rt]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[-wb, y - 0.05, rt], [-wb, y + 0.05, rt]]} color="#22d3ee" lineWidth={2} />

      {/* Wheelbase (left side) */}
      <Line points={[[wb, y, -ft], [-wb, y, -rt]]} color="#a78bfa" lineWidth={2} />
      <Line points={[[wb, y - 0.05, -ft], [wb, y + 0.05, -ft]]} color="#a78bfa" lineWidth={2} />
      <Line points={[[-wb, y - 0.05, -rt], [-wb, y + 0.05, -rt]]} color="#a78bfa" lineWidth={2} />

      {/* Labels using sprite-based text (HTML overlay is complex in R3F, use simple meshes) */}
      <DimensionLabel position={[wb, y + 0.15, 0]} text={`${(ft * 2 * 1000).toFixed(0)}mm`} color="#22d3ee" />
      <DimensionLabel position={[-wb, y + 0.15, 0]} text={`${(rt * 2 * 1000).toFixed(0)}mm`} color="#22d3ee" />
      <DimensionLabel position={[0, y + 0.15, -(ft + rt) / 2]} text={`${(wb * 2 * 1000).toFixed(0)}mm`} color="#a78bfa" />
    </group>
  );
}

function DimensionLabel({ position, text, color }: { position: [number, number, number]; text: string; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "bold 36px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);
    canvasRef.current = canvas;
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={position} scale={[1.2, 0.3, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

// ── Camera presets ───────────────────────────────────────────────

type ViewPreset = "3/4" | "front" | "rear" | "left" | "right" | "top";

const VIEW_PRESETS: Record<ViewPreset, { position: [number, number, number]; target: [number, number, number] }> = {
  "3/4":  { position: [4, 2.5, 4],    target: [0, 0, 0] },
  front:  { position: [5, 1.5, 0],    target: [0, 0, 0] },
  rear:   { position: [-5, 1.5, 0],   target: [0, 0, 0] },
  left:   { position: [0, 0, -5],     target: [0, 0, 0] },
  right:  { position: [0, 0, 5],      target: [0, 0, 0] },
  top:    { position: [0, 7, 0.01],   target: [0, 0, 0] },
};

function AutoChaseCamera({ packet }: { packet: TelemetryPacket }) {
  const { camera } = useThree();
  const smoothYaw = useRef(packet.Yaw);

  useFrame(() => {
    // Smooth the yaw to avoid jerky camera
    let diff = packet.Yaw - smoothYaw.current;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    smoothYaw.current += diff * 0.04;

    const yaw = smoothYaw.current;
    const radius = 5;
    const height = 1.8;
    // Camera sits behind the car: car faces -Z in Forza coords, yaw=0 is forward
    camera.position.set(
      Math.sin(yaw) * radius,
      height,
      Math.cos(yaw) * radius,
    );
    camera.lookAt(0, 0.3, 0);
  });

  return null;
}

function CameraController({ viewPreset }: { viewPreset: ViewPreset }) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const lastPreset = useRef<ViewPreset>(viewPreset);

  useFrame(() => {
    if (viewPreset !== lastPreset.current) {
      lastPreset.current = viewPreset;
      const preset = VIEW_PRESETS[viewPreset];
      camera.position.set(...preset.position);
      if (controlsRef.current) {
        controlsRef.current.target.set(...preset.target);
        controlsRef.current.update();
      }
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan={false}
      enableZoom={true}
      minDistance={3}
      maxDistance={2000}
      minPolarAngle={0}
      maxPolarAngle={Math.PI}
    />
  );
}

function CarScene({ packet: packetProp, telemetry, cursorIdx, outline, boundaries, toggles, viewPreset, carModel, modelOffsetX, fmtTemp, hideModelWheels, suspThresholds, autoOrbit }: { packet: TelemetryPacket; telemetry: TelemetryPacket[]; cursorIdx: number; outline: { x: number; z: number }[] | null; boundaries: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[] } | null; toggles: ViewToggles; viewPreset: ViewPreset; carModel: CarModelEnrichment & { hasModel: boolean }; modelOffsetX: number; fmtTemp: (f: number) => string; hideModelWheels?: boolean; suspThresholds: number[]; autoOrbit?: boolean }) {
  // Keep packet in a ref so useFrame reads latest without triggering re-render
  const packetRef = useRef(packetProp);
  packetRef.current = packetProp;
  const packet = packetProp; // still use prop for JSX (re-renders at 10fps)
  const carGroupRef = useRef<THREE.Group>(null);
  const prevTimeRef = useRef(packet.TimestampMS);
  const prevWear = useRef([packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR]);
  const wearRates = useRef([0, 0, 0, 0]);

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
  const dt = (packet.TimestampMS - prevTimeRef.current) / 1000;
  prevTimeRef.current = packet.TimestampMS;
  const currentWear = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  if (dt > 0 && dt < 1) {
    for (let i = 0; i < 4; i++) {
      const rawRate = (prevWear.current[i] - currentWear[i]) / dt;
      wearRates.current[i] = wearRates.current[i] * 0.9 + rawRate * 0.1;
    }
  }
  prevWear.current = currentWear;

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
    { pos: [wb, 0, -ft] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFL, slip: Math.abs(packet.TireCombinedSlipFL), temp: packet.TireTempFL, brakeTemp: packet.BrakeTempFrontLeft ?? packet.f1?.brakeTempFL ?? 0, onRumble: packet.WheelOnRumbleStripFL !== 0, puddle: packet.WheelInPuddleDepthFL, wearRate: wearRates.current[0], wear: packet.TireWearFL, rotSpeed: rotFL, tireRadius: fTireR, tireWidth: fTireW },
    { pos: [wb, 0, ft] as [number, number, number], steer: steerRad, susp: packet.NormSuspensionTravelFR, slip: Math.abs(packet.TireCombinedSlipFR), temp: packet.TireTempFR, brakeTemp: packet.BrakeTempFrontRight ?? packet.f1?.brakeTempFR ?? 0, onRumble: packet.WheelOnRumbleStripFR !== 0, puddle: packet.WheelInPuddleDepthFR, wearRate: wearRates.current[1], wear: packet.TireWearFR, rotSpeed: rotFR, tireRadius: fTireR, tireWidth: fTireW },
    { pos: [-wb, 0, -rt] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRL, slip: Math.abs(packet.TireCombinedSlipRL), temp: packet.TireTempRL, brakeTemp: packet.BrakeTempRearLeft ?? packet.f1?.brakeTempRL ?? 0, onRumble: packet.WheelOnRumbleStripRL !== 0, puddle: packet.WheelInPuddleDepthRL, wearRate: wearRates.current[2], wear: packet.TireWearRL, rotSpeed: rotRL, tireRadius: rTireR, tireWidth: rTireW },
    { pos: [-wb, 0, rt] as [number, number, number], steer: 0, susp: packet.NormSuspensionTravelRR, slip: Math.abs(packet.TireCombinedSlipRR), temp: packet.TireTempRR, brakeTemp: packet.BrakeTempRearRight ?? packet.f1?.brakeTempRR ?? 0, onRumble: packet.WheelOnRumbleStripRR !== 0, puddle: packet.WheelInPuddleDepthRR, wearRate: wearRates.current[3], wear: packet.TireWearRR, rotSpeed: rotRR, tireRadius: rTireR, tireWidth: rTireW },
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
            gripColor={tractionColor(w.slip, packet.gameId)}
            tempColor={tireTempColor(w.temp)}
            rotationSpeed={w.rotSpeed}
            temp={w.temp}
            displayTemp={fmtTemp(w.temp)}
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

// ── Exported wrapper ───────────────────────────────────────────────

interface ViewToggles {
  solid: "wire" | "solid" | "hidden";
  springs: boolean;
  trails: boolean;
  inputs: boolean;
  track: boolean;
  grid: boolean;
  drivetrain: boolean;
  dimensions: boolean;
}

const DEFAULT_TOGGLES: ViewToggles = {
  solid: "wire" as const,
  springs: true,
  trails: true,
  inputs: false,
  track: true,
  grid: true,
  drivetrain: true,
  dimensions: false,
};

function ToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-[9px] uppercase tracking-wider font-semibold rounded border transition-colors ${
        active
          ? "bg-cyan-900/50 border-cyan-700 text-app-accent"
          : "bg-app-surface-alt/80 border-app-border-input text-app-text-muted hover:text-app-text"
      }`}
    >
      {label}
    </button>
  );
}

export const CarWireframe = React.memo(function CarWireframe({
  packet,
  telemetry,
  cursorIdx,
  outline,
  boundaries,
  carOrdinal,
  carModel: carModelProp,
  tempLabel: tempLabelProp,
  cursorRef: _cursorRefProp,
  telemetryRef: _telemetryRefProp,
  showDimensions,
  minimal,
  hideControls,
  autoOrbit,
}: {
  packet: TelemetryPacket;
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
  boundaries?: { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[] } | null;
  carOrdinal?: number;
  carModel?: CarModelEnrichment & { hasModel: boolean };
  tempLabel?: string;
  cursorRef?: React.RefObject<number>;
  telemetryRef?: React.RefObject<TelemetryPacket[]>;
  showDimensions?: boolean;
  minimal?: boolean;
  hideControls?: boolean;
  autoOrbit?: boolean;
  onModelOffset?: (offset: { x: number; y: number; z: number }) => void;
}) {
  const [configsLoaded, setConfigsLoaded] = useState(false);
  useEffect(() => { loadCarModelConfigs().then(() => setConfigsLoaded(true)); }, []);
  const gameId = useGameId();
  const isF1 = gameId === "f1-2025";

  const isFM = gameId === "fm-2023";
  const carModel = useMemo(() => {
    if (carModelProp) return carModelProp;
    if (isF1) return F1_CAR;
    const perCar = getCarModel(carOrdinal ?? 0);
    if (perCar.hasModel) return perCar;
    if (isFM) return DEMO_CAR;
    return perCar;
  }, [carOrdinal, configsLoaded, isF1, isFM, carModelProp]);
  const units = useUnits();
  const { displaySettings } = useSettings();
  const suspThresholds = displaySettings.suspensionThresholds.values;
  const tLabel = tempLabelProp ?? units.tempLabel;
  const fmtTemp = useCallback((v: number) => `${v.toFixed(0)}${tLabel}`, [tLabel]);
  const [editMode, setEditMode] = useState(false);
  const [modelOffsetX, setModelOffsetX] = useState(carModel.glbOffsetX ?? 0);
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved">("");
  const [toggles, setToggles] = useLocalStorage<ViewToggles>("carwireframe-toggles", {
    ...DEFAULT_TOGGLES,
    dimensions: showDimensions ?? false,
  });
  const [viewPreset, setViewPreset] = useState<ViewPreset>("3/4");

  const toggle = (key: keyof ViewToggles) =>
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));

  const fpsRef = useRef<HTMLSpanElement>(null);
  const fpsFrames = useRef(0);
  const fpsLastTime = useRef(performance.now());

  return (
    <div className="w-full h-full relative flex-1">
      <Canvas
        camera={{ position: [4, 2.5, 4], fov: 50 }}
        gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 1.5]}
        style={{ background: "transparent" }}
        onCreated={({ gl }) => {
          const origRender = gl.render.bind(gl);
          gl.render = (...args: Parameters<typeof gl.render>) => {
            fpsFrames.current++;
            const now = performance.now();
            if (now - fpsLastTime.current >= 1000) {
              if (fpsRef.current) fpsRef.current.textContent = `${fpsFrames.current} fps`;
              fpsFrames.current = 0;
              fpsLastTime.current = now;
            }
            return origRender(...args);
          };
        }}
      >
        <CarScene packet={packet} telemetry={telemetry} cursorIdx={cursorIdx} outline={outline} boundaries={boundaries ?? null} toggles={toggles} viewPreset={viewPreset} carModel={carModel} modelOffsetX={modelOffsetX} fmtTemp={fmtTemp} hideModelWheels={!minimal} suspThresholds={suspThresholds} autoOrbit={autoOrbit} />
      </Canvas>
      <span ref={fpsRef} className="absolute bottom-1 right-24 text-sm font-mono text-app-text-dim/50 px-1 py-0.5" />

      {/* View toggles */}
      {!hideControls && <div className="absolute top-2 left-2 flex flex-wrap gap-1 max-w-[65%]">
        <ToggleButton
          label={toggles.solid === "solid" ? "Solid" : toggles.solid === "hidden" ? "Hidden" : "Wire"}
          active={toggles.solid !== "wire"}
          onClick={() => setToggles((prev) => ({
            ...prev,
            solid: prev.solid === "wire" ? "solid" : prev.solid === "solid" ? "hidden" : "wire",
          }))}
        />
        {!minimal && <ToggleButton label="Springs" active={toggles.springs} onClick={() => toggle("springs")} />}
        {!minimal && <ToggleButton label="Trails" active={toggles.trails} onClick={() => toggle("trails")} />}
        {!minimal && <ToggleButton label="Inputs" active={toggles.inputs} onClick={() => toggle("inputs")} />}
        {!minimal && <ToggleButton label="Track" active={toggles.track} onClick={() => toggle("track")} />}
        {!minimal && <ToggleButton label="Grid" active={toggles.grid} onClick={() => toggle("grid")} />}
        {!minimal && <ToggleButton label="Drive" active={toggles.drivetrain} onClick={() => toggle("drivetrain")} />}
        {minimal && <ToggleButton label="Dims" active={toggles.dimensions} onClick={() => toggle("dimensions")} />}
      </div>}

      {/* Camera presets + steering indicator */}
      {!hideControls && <div className="absolute top-2 right-2 flex flex-col gap-2 items-end">
        <div className="flex flex-col gap-1">
          {(Object.keys(VIEW_PRESETS) as ViewPreset[]).map((key) => (
            <ToggleButton key={key} label={key} active={viewPreset === key} onClick={() => setViewPreset(key)} />
          ))}
        </div>

      </div>}

      {/* Model edit controls (minimal/car viewer mode) */}
      {!hideControls && minimal && !editMode && carModel.hasModel && (
        <button
          onClick={() => setEditMode(true)}
          className="absolute bottom-2 left-2 px-2 py-1 text-[10px] rounded bg-app-surface-alt/80 border border-app-border-input text-app-text-muted hover:text-app-text transition-colors"
        >
          Edit Model
        </button>
      )}
      {!hideControls && minimal && editMode && (
        <div className="absolute bottom-2 left-2 bg-app-bg/90 rounded-lg border border-app-border p-2 text-[10px] font-mono space-y-1.5" style={{ minWidth: 220 }}>
          <div className="flex items-center justify-between">
            <span className="text-app-text-muted uppercase tracking-wider">Model Offset</span>
            <div className="flex gap-1">
              <button
                onClick={async () => {
                  setSaveStatus("saving");
                  try {
                    const res = await client.api["car-model-configs"][":ordinal"].$put({
                      param: { ordinal: String(carOrdinal) },
                      json: { glbOffsetX: modelOffsetX },
                    });
                    if (res.ok) {
                      setSaveStatus("saved");
                      setTimeout(() => { setSaveStatus(""); setEditMode(false); }, 1000);
                    } else {
                      setSaveStatus("");
                    }
                  } catch {
                    setSaveStatus("");
                  }
                }}
                className={`px-1.5 py-0.5 rounded border transition-colors ${
                  saveStatus === "saved"
                    ? "bg-green-600 text-white border-green-400"
                    : "bg-green-700/80 hover:bg-green-600 text-white border-green-500/30"
                }`}
              >
                {saveStatus === "saving" ? "..." : saveStatus === "saved" ? "Saved" : "Save"}
              </button>
              <button
                onClick={() => { setEditMode(false); setModelOffsetX(carModel.glbOffsetX ?? 0); }}
                className="px-1.5 py-0.5 rounded bg-app-surface-alt border border-app-border-input text-app-text-muted hover:text-app-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-app-text-muted w-8">X</span>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.01}
              value={modelOffsetX}
              onChange={(e) => setModelOffsetX(parseFloat(e.target.value))}
              className="flex-1 accent-app-accent"
            />
            <span className="text-app-text w-14 text-right">{(modelOffsetX * 1000).toFixed(0)}mm</span>
          </div>
        </div>
      )}

      {/* Input bars removed — shown on 2D track map panel + 3D input overlay */}
    </div>
  );
});
