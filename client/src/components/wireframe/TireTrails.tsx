import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import type { CarModelEnrichment } from "../../data/car-models";
import { getWheelOffsets, trailColorFromState } from "../../lib/wireframe-utils";
import { allWheelStates } from "../../lib/vehicle-dynamics";

// Upper bound on trail segments across all 4 wheels. At ACC's ~300 Hz
// physics with the 80 ms trail duration, a single wheel keeps ~24 points
// (23 segments), so 4 × 23 = 92 worst case. Round up generously.
const MAX_TRAIL_INSTANCES = 256;

export function TireTrails({
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

  // Per-wheel slip-state callbacks (unchanged — drives per-segment color).
  const slipFns = useMemo(
    () => [
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFL),
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFR),
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRL),
      (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRR),
    ],
    [],
  );
  const wheelKeys = useMemo(() => ["fl", "fr", "rl", "rr"] as const, []);

  // Compute trail points + colors for all 4 wheels on cursor change.
  // Shape matches the previous implementation so downstream layout-effect
  // can just walk it segment by segment.
  const trails = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return null;
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
        const ws = allWheelStates(p);
        cols.push(trailColorFromState(ws[wheelKeys[w]].state, slipFns[w](p)));
      }
      return { pts, cols };
    });
  }, [telemetry, cursorIdx, WHEEL_OFFSETS, slipFns, wheelKeys]);

  // Single instancedMesh across all 4 wheels — one draw call for everything.
  // Each instance is a thin box stretched to a segment length and rotated
  // to align with the segment direction. Per-segment color via setColorAt.
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    if (!trails) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }

    let instance = 0;
    for (const trail of trails) {
      const n = trail.cols.length;
      for (let i = 0; i < n - 1; i++) {
        if (instance >= MAX_TRAIL_INSTANCES) break;
        const x0 = trail.pts[i * 3];
        const y0 = trail.pts[i * 3 + 1];
        const z0 = trail.pts[i * 3 + 2];
        const x1 = trail.pts[(i + 1) * 3];
        const y1 = trail.pts[(i + 1) * 3 + 1];
        const z1 = trail.pts[(i + 1) * 3 + 2];

        const dx = x1 - x0;
        const dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 0.001) continue;

        // Midpoint of segment
        dummy.position.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
        // Rotate around Y so local +Z points along the segment direction
        dummy.rotation.set(0, Math.atan2(dx, dz), 0);
        // Thin on X (cross-track width) and Y (height), stretched to segment length on Z
        dummy.scale.set(0.025, 0.01, len);
        dummy.updateMatrix();
        mesh.setMatrixAt(instance, dummy.matrix);
        mesh.setColorAt(instance, trail.cols[i]);
        instance++;
      }
      if (instance >= MAX_TRAIL_INSTANCES) break;
    }

    mesh.count = instance;
    mesh.instanceMatrix.needsUpdate = true;
    // instanceColor is lazily created by setColorAt on first call.
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Instances move around the car every frame; skip frustum culling so
    // they don't disappear at window edges.
    mesh.frustumCulled = false;
  }, [trails, dummy]);

  // Release GPU instance buffer on unmount (R3F handles geometry + material
  // from JSX children, but not the InstancedMesh's own instance attributes).
  // Capture the ref inside the effect body so the cleanup disposes the
  // same instance we installed, not whatever the ref points to at
  // teardown time.
  useEffect(() => {
    const mesh = meshRef.current;
    return () => {
      mesh?.dispose();
    };
  }, []);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_TRAIL_INSTANCES]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial />
    </instancedMesh>
  );
}
