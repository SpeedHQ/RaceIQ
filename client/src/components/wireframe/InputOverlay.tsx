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

    // Collect contiguous in-range runs. Splitting on out-of-range points
    // prevents a single polyline from bridging two disjoint clusters
    // (e.g. start/finish loopback) with a straight line across the scene.
    type LocalPt = { fwd: number; lat: number; throttle: number; brake: number };
    const runs: LocalPt[][] = [];
    let current: LocalPt[] = [];
    for (const p of telemetry) {
      const dx = p.PositionX - cx;
      const dz = p.PositionZ - cz;
      let inRange = dx * dx + dz * dz <= maxDist2;
      let localFwd = 0, localLat = 0;
      if (inRange) {
        localFwd = dx * s + dz * c;
        localLat = dx * c - dz * s;
        if (localFwd < -BEHIND || localFwd > AHEAD || Math.abs(localLat) > 30) inRange = false;
      }
      if (inRange) {
        current.push({ fwd: localFwd, lat: localLat, throttle: (p.Accel ?? 0) / 255, brake: (p.Brake ?? 0) / 255 });
      } else if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length > 0) runs.push(current);

    // Compute perpendicular normals and build per-run offset lines.
    const throttleRuns: { pts: [number, number, number][]; cols: THREE.Color[] }[] = [];
    const brakeRuns: { pts: [number, number, number][]; cols: THREE.Color[] }[] = [];

    for (const pts of runs) {
      if (pts.length < 2) continue;
      // Active sub-runs — accumulate while throttle/brake > 0, flush on drop.
      // Prevents Line from bridging points where input was momentarily off.
      let tPts: [number, number, number][] = [];
      let tCols: THREE.Color[] = [];
      let bPts: [number, number, number][] = [];
      let bCols: THREE.Color[] = [];
      const flushT = () => {
        if (tPts.length > 1) throttleRuns.push({ pts: tPts, cols: tCols });
        tPts = [];
        tCols = [];
      };
      const flushB = () => {
        if (bPts.length > 1) brakeRuns.push({ pts: bPts, cols: bCols });
        bPts = [];
        bCols = [];
      };
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const tFwd = next.fwd - prev.fwd;
        const tLat = next.lat - prev.lat;
        const len = Math.sqrt(tFwd * tFwd + tLat * tLat) || 1;
        const nFwd = -tLat / len;
        const nLat = tFwd / len;
        const p = pts[i];
        if (p.throttle > 0) {
          tPts.push([p.fwd + nFwd * OFFSET, Y, p.lat + nLat * OFFSET]);
          tCols.push(new THREE.Color(0, 0, 0).lerp(THROTTLE_COLOR, p.throttle));
        } else {
          flushT();
        }
        if (p.brake > 0) {
          bPts.push([p.fwd - nFwd * OFFSET, Y, p.lat - nLat * OFFSET]);
          bCols.push(new THREE.Color(0, 0, 0).lerp(BRAKE_COLOR, p.brake));
        } else {
          flushB();
        }
      }
      flushT();
      flushB();
    }

    return { throttleRuns, brakeRuns };
  }, [telemetry, packet.PositionX, packet.PositionZ, packet.Yaw]);

  return (
    <>
      {data.throttleRuns.map((run, i) => (
        <Line key={`t-${i}`} points={run.pts} vertexColors={run.cols} lineWidth={3} transparent opacity={0.9} />
      ))}
      {data.brakeRuns.map((run, i) => (
        <Line key={`b-${i}`} points={run.pts} vertexColors={run.cols} lineWidth={3} transparent opacity={0.9} />
      ))}
    </>
  );
}
