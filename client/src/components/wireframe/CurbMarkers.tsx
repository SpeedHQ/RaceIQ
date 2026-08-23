import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { semanticNumber, type SemanticAnalysisFrame } from "../track-map/types";
import type { CarModelEnrichment } from "../../data/car-models";
import { buildTrackIndex, filterByDistanceIndexed, THREE_COLORS } from "../../lib/wireframe-utils";

export function CurbMarkers({ telemetry, packet, carModel }: { telemetry: SemanticAnalysisFrame[]; cursorIdx?: number; packet: SemanticAnalysisFrame; carModel: CarModelEnrichment }) {
  // Wheel offsets in car-local frame: [forward, right] in meters
  // Forza world: forward = (sin(yaw), cos(yaw)), right = (cos(yaw), -sin(yaw))
  // Forza PositionX/Z is ~0.065m ahead of geometric center (measured from
  // front→rear curb entry timing vs extracted wheelbase), so shift wheels back
  const posOffset = 0.065;
  const wheelOffsets = useMemo(
    () => ({
      FL: { fwd: carModel.halfWheelbase - posOffset, rgt: -carModel.halfFrontTrack },
      FR: { fwd: carModel.halfWheelbase - posOffset, rgt: carModel.halfFrontTrack },
      RL: { fwd: -carModel.halfWheelbase - posOffset, rgt: -carModel.halfRearTrack },
      RR: { fwd: -carModel.halfWheelbase - posOffset, rgt: carModel.halfRearTrack },
    }),
    [carModel],
  );

  // Compute world-space wheel position
  const wheelWorld = (p: SemanticAnalysisFrame, off: { fwd: number; rgt: number }) => {
    const s = Math.sin((semanticNumber(p, "motion.yaw") ?? 0));
    const c = Math.cos((semanticNumber(p, "motion.yaw") ?? 0));
    return {
      x: (semanticNumber(p, "motion.position-x") ?? 0) + off.fwd * s + off.rgt * c,
      z: (semanticNumber(p, "motion.position-z") ?? 0) + off.fwd * c - off.rgt * s,
    };
  };

  // Build world-space curb contact points per wheel from full telemetry
  const { leftCurb, rightCurb, puddlePoints } = useMemo(() => {
    void wheelOffsets;
    void wheelWorld;
    return { leftCurb: [], rightCurb: [], puddlePoints: [] };
  }, [telemetry]);

  const cx = (semanticNumber(packet, "motion.position-x") ?? 0);
  const cz = (semanticNumber(packet, "motion.position-z") ?? 0);
  const yaw = (semanticNumber(packet, "motion.yaw") ?? 0);
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
  const curbPts = useMemo(() => curbSegs.flatMap((segment) => segment.points), [curbSegs]);
  const puddlePts = useMemo(() => puddleSegs.flatMap((segment) => segment.points), [puddleSegs]);

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
          <meshBasicMaterial color={THREE_COLORS.surfaceContact} transparent opacity={0.9} />
        </instancedMesh>
      )}
      {puddlePoints.length > 0 && (
        <instancedMesh ref={puddleRef} args={[undefined, undefined, puddleCap]}>
          <sphereGeometry args={[0.1, 6, 6]} />
          <meshBasicMaterial color={THREE_COLORS.surfaceWet} transparent opacity={0.5} />
        </instancedMesh>
      )}
    </>
  );
}
