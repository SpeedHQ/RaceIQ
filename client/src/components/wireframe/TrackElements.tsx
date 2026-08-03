import { Line } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { buildTrackIndex, createWallGeometry, DIST_AHEAD, filterByDistanceIndexed, THREE_COLORS, updateWallGeometry } from "../../lib/wireframe-utils";

export function TrackOutline({ outline, packet, distAhead }: { outline: { x: number; z: number }[]; packet: TelemetryPacket; distAhead?: number }) {
  const ahead = distAhead ?? DIST_AHEAD;
  // One-time index build per outline — stable while the reference is stable
  // (React Query returns the same object until refetch).
  const index = useMemo(() => buildTrackIndex(outline), [outline]);
  const segments = useMemo(() => filterByDistanceIndexed(index, packet.PositionX, packet.PositionZ, packet.Yaw, -0.44, ahead), [index, packet.PositionX, packet.PositionZ, packet.Yaw, ahead]);

  if (segments.length === 0) return null;

  return (
    <>
      {segments.map((seg) => (
        <Line key={`${seg[0].join(",")}-${seg[seg.length - 1].join(",")}`} points={seg} color={THREE_COLORS.appText} lineWidth={3} opacity={0.6} transparent />
      ))}
    </>
  );
}

export function TrackBoundaryEdges({
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

  // One-time index per edge; rebuilds only when the underlying array
  // reference changes.
  const leftIndex = useMemo(() => buildTrackIndex(boundaries.leftEdge), [boundaries.leftEdge]);
  const rightIndex = useMemo(() => buildTrackIndex(boundaries.rightEdge), [boundaries.rightEdge]);

  // Pre-allocate wall geometries once per mount — buffers are mutated
  // in place by updateWallGeometry on each cursor change, avoiding the
  // per-frame BufferGeometry + Float32Array churn that GCs otherwise.
  const leftGeom = useMemo(() => createWallGeometry(), []);
  const rightGeom = useMemo(() => createWallGeometry(), []);

  // Free GPU buffers when the component unmounts.
  useEffect(() => {
    return () => {
      leftGeom.dispose();
      rightGeom.dispose();
    };
  }, [leftGeom, rightGeom]);

  // Filter by distance, then fill the pre-allocated buffers in place.
  // useLayoutEffect so geometry updates land before the next paint.
  const leftSegsGround = useMemo(
    () => filterByDistanceIndexed(leftIndex, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead),
    [leftIndex, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead],
  );
  const rightSegsGround = useMemo(
    () => filterByDistanceIndexed(rightIndex, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead),
    [rightIndex, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead],
  );

  useLayoutEffect(() => {
    updateWallGeometry(leftGeom, leftSegsGround, WALL_HEIGHT);
  }, [leftGeom, leftSegsGround]);
  useLayoutEffect(() => {
    updateWallGeometry(rightGeom, rightSegsGround, WALL_HEIGHT);
  }, [rightGeom, rightSegsGround]);

  return (
    <>
      <mesh geometry={leftGeom}>
        <meshBasicMaterial color={THREE_COLORS.trackCurbLeft} opacity={0.5} transparent side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={rightGeom}>
        <meshBasicMaterial color={THREE_COLORS.trackCurbRight} opacity={0.5} transparent side={THREE.DoubleSide} />
      </mesh>
    </>
  );
}
