import { useMemo } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { TelemetryPacket } from "@shared/types";
import { THROTTLE_COLOR, BRAKE_COLOR } from "../../lib/wireframe-utils";

export function InputOverlay({
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
