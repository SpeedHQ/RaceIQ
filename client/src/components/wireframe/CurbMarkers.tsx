import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import type { CarModelEnrichment } from "../../data/car-models";
import { buildTrackIndex, filterByDistanceIndexed } from "../../lib/wireframe-utils";

export function CurbMarkers({
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

  // Chunk-AABB indexes — stable across cursor moves, rebuilt only when
  // the underlying curb/puddle arrays change (i.e. on lap change).
  const curbIndex = useMemo(() => buildTrackIndex(allCurb), [allCurb]);
  const puddleIndex = useMemo(() => buildTrackIndex(puddlePoints), [puddlePoints]);

  const curbSegs = useMemo(() => filterByDistanceIndexed(curbIndex, cx, cz, yaw, GROUND_Y), [curbIndex, cx, cz, yaw, GROUND_Y]);
  const puddleSegs = useMemo(() => filterByDistanceIndexed(puddleIndex, cx, cz, yaw, GROUND_Y), [puddleIndex, cx, cz, yaw, GROUND_Y]);

  // Flatten segments into individual points for rendering as instance positions
  const curbPts = useMemo(() => curbSegs.flatMap(seg => seg), [curbSegs]);
  const puddlePts = useMemo(() => puddleSegs.flatMap(seg => seg), [puddleSegs]);

  // Instanced mesh refs — one draw call per marker type instead of one
  // `<mesh>` per point. Capacity sized to the total per-lap curb/puddle
  // count (bounded), `count` controls how many are drawn.
  const curbRef = useRef<THREE.InstancedMesh>(null);
  const puddleRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Push visible points into instance matrices on every cursor change.
  // useLayoutEffect so GPU state is in sync before the next paint.
  useLayoutEffect(() => {
    const mesh = curbRef.current;
    if (!mesh) return;
    const capacity = mesh.instanceMatrix.count;
    const n = Math.min(curbPts.length, capacity);
    for (let i = 0; i < n; i++) {
      dummy.position.set(curbPts[i][0], curbPts[i][1], curbPts[i][2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }, [curbPts, dummy]);

  useLayoutEffect(() => {
    const mesh = puddleRef.current;
    if (!mesh) return;
    const capacity = mesh.instanceMatrix.count;
    const n = Math.min(puddlePts.length, capacity);
    for (let i = 0; i < n; i++) {
      dummy.position.set(puddlePts[i][0], puddlePts[i][1], puddlePts[i][2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }, [puddlePts, dummy]);

  // Dispose GPU resources on unmount. R3F handles child geometry/material,
  // but the InstancedMesh itself keeps its own instance buffer. Capture
  // the current refs at effect-run time so the cleanup sees the same
  // instances we installed, not whatever React reconciles onto them
  // during teardown.
  useEffect(() => {
    const curb = curbRef.current;
    const puddle = puddleRef.current;
    return () => {
      curb?.dispose();
      puddle?.dispose();
    };
  }, []);

  // Capacity needs to be at least 1 — InstancedMesh with count 0 is invalid.
  const curbCap = Math.max(1, allCurb.length);
  const puddleCap = Math.max(1, puddlePoints.length);

  if (allCurb.length === 0 && puddlePoints.length === 0) return null;

  return (
    <>
      {allCurb.length > 0 && (
        <instancedMesh ref={curbRef} args={[undefined, undefined, curbCap]}>
          <sphereGeometry args={[0.02, 6, 6]} />
          <meshBasicMaterial color="#ff8800" transparent opacity={0.9} />
        </instancedMesh>
      )}
      {puddlePoints.length > 0 && (
        <instancedMesh ref={puddleRef} args={[undefined, undefined, puddleCap]}>
          <sphereGeometry args={[0.1, 6, 6]} />
          <meshBasicMaterial color="#3b82f6" transparent opacity={0.5} />
        </instancedMesh>
      )}
    </>
  );
}
