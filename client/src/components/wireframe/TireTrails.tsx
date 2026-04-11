import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import type { CarModelEnrichment } from "../../data/car-models";
import { getWheelOffsets, trailColorFromState } from "../../lib/wireframe-utils";
import { allWheelStates } from "../../lib/vehicle-dynamics";
import { useGameId } from "../../stores/game";

// Trail length in meters of track behind each wheel. Distance-based so the
// visual length is stable across games, packet rates, car speed, and any
// recorded-timestamp jitter (notably ACC, which stamps with Date.now()).
// ACC gets a shorter trail — its slip signal is tighter and long trails
// over-emphasize the effect.
const TRAIL_LENGTH_M_DEFAULT = 4;
const TRAIL_LENGTH_M_ACC = 2;
// Hard cap on samples walked back from the cursor. Bounds worst-case work at
// very low speed where the arc-length target is never reached.
const MAX_TRAIL_SAMPLES = 64;
// Upper bound on trail segments across all 4 wheels:
// MAX_TRAIL_SAMPLES × 4 wheels = 256 worst case.
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
  const gameId = useGameId();
  const trailLengthM = gameId === "acc" ? TRAIL_LENGTH_M_ACC : TRAIL_LENGTH_M_DEFAULT;
  const WHEEL_OFFSETS = useMemo(() => getWheelOffsets(carModel), [carModel]);

  // Per-wheel slip-angle extractor (radians). Slip ratio comes from
  // allWheelStates (rot-speed-derived SAE ratio, not the game's raw
  // TireSlipRatio field which uses per-game scaling).
  const angleFns = useMemo(
    () => [
      (p: TelemetryPacket) => p.TireSlipAngleFL,
      (p: TelemetryPacket) => p.TireSlipAngleFR,
      (p: TelemetryPacket) => p.TireSlipAngleRL,
      (p: TelemetryPacket) => p.TireSlipAngleRR,
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
    // Walk back along the recorded path, summing hypot between adjacent
    // samples, until we have trailLengthM meters of track behind the car.
    // Cumulative arc length (not straight-line to cursor) so hairpins that
    // loop back near the cursor's XZ don't cut the walk short.
    let startIdx = cursorIdx;
    let acc = 0;
    let lastSegLen = 0;
    while (startIdx > 0 && cursorIdx - startIdx < MAX_TRAIL_SAMPLES) {
      const a = telemetry[startIdx];
      const b = telemetry[startIdx - 1];
      lastSegLen = Math.hypot(a.PositionX - b.PositionX, a.PositionZ - b.PositionZ);
      acc += lastSegLen;
      startIdx--;
      if (acc >= trailLengthM) break;
    }
    if (cursorIdx - startIdx < 2) return null;
    // Fractional clip of the oldest segment so the rear endpoint sits at
    // *exactly* trailLengthM behind the car. Without this, the tail snaps
    // between whole-sample boundaries each cursor tick → visible jitter.
    // startIdx points to the oldest included sample; if we overshot, nudge
    // it toward telemetry[startIdx + 1] by (overshoot / lastSegLen).
    const overshoot = acc - trailLengthM;
    const tailFrac = overshoot > 0 && lastSegLen > 1e-6 ? overshoot / lastSegLen : 0;

    const cx = cur.PositionX, cz = cur.PositionZ;
    const s = Math.sin(cur.Yaw), c = Math.cos(cur.Yaw);

    return WHEEL_OFFSETS.map((off, w) => {
      const pts = new Float32Array((cursorIdx - startIdx + 1) * 3);
      const cols: THREE.Color[] = [];
      for (let i = startIdx, j = 0; i <= cursorIdx; i++, j++) {
        const p = telemetry[i];
        // For the oldest sample, lerp toward the next sample by tailFrac so
        // the rear endpoint lands at exactly trailLengthM (kills tail jitter).
        let px = p.PositionX;
        let pz = p.PositionZ;
        if (i === startIdx && tailFrac > 0) {
          const next = telemetry[startIdx + 1];
          px += (next.PositionX - px) * tailFrac;
          pz += (next.PositionZ - pz) * tailFrac;
        }
        const dx = px - cx, dz = pz - cz;
        pts[j * 3] = dx * s + dz * c + off[0];
        pts[j * 3 + 1] = -0.42;
        pts[j * 3 + 2] = dx * c - dz * s + off[1];
        const ws = allWheelStates(p);
        const wsWheel = ws[wheelKeys[w]];
        cols.push(trailColorFromState(wsWheel.state, wsWheel.slipRatio, angleFns[w](p)));
      }
      return { pts, cols };
    });
  }, [telemetry, cursorIdx, WHEEL_OFFSETS, angleFns, wheelKeys, trailLengthM]);

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
