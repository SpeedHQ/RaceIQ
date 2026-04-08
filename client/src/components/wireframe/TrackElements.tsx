import { useMemo, useCallback } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import { filterByDistance, DIST_AHEAD } from "../../lib/wireframe-utils";

export function TrackOutline({
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

  // Pre-compute full wall geometry once — filter by distance on cursor change
  const leftSegsGround = useMemo(() => filterByDistance(boundaries.leftEdge, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead), [boundaries.leftEdge, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead]);
  const rightSegsGround = useMemo(() => filterByDistance(boundaries.rightEdge, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead), [boundaries.rightEdge, packet.PositionX, packet.PositionZ, packet.Yaw, GROUND_Y, ahead]);

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
