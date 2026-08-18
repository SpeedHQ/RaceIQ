import { Line } from "@react-three/drei";
import { useMemo } from "react";
import type * as THREE from "three";
import { semanticNumber, type SemanticAnalysisFrame } from "../track-map/types";
import { pedalInputColor, threeColor } from "../../lib/wireframe-utils";

export function InputOverlay({ telemetry, packet }: { telemetry: SemanticAnalysisFrame[]; packet: SemanticAnalysisFrame }) {
  const data = useMemo(() => {
    const throttleColor = threeColor("var(--ch-throttle)");
    const brakeColor = threeColor("var(--ch-brake)");
    const inactiveColor = threeColor("var(--app-bg)");
    const cx = (semanticNumber(packet, "motion.position-x") ?? 0);
    const cz = (semanticNumber(packet, "motion.position-z") ?? 0);
    const yaw = (semanticNumber(packet, "motion.yaw") ?? 0);
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const Y = -0.44; // match TrackOutline race-line Y
    const OFFSET = 0.1; // lateral offset from center in meters
    const AHEAD = 60;
    const BEHIND = 20;
    const maxDist2 = AHEAD * AHEAD;

    // Collect contiguous in-range runs. Splitting on out-of-range points
    // prevents a single polyline from bridging two disjoint clusters
    // (e.g. start/finish loopback) with a straight line across the scene.
    type LocalPt = { sourceIndex: number; fwd: number; lat: number; throttle: number; brake: number };
    const runs: LocalPt[][] = [];
    let current: LocalPt[] = [];
    for (let sourceIndex = 0; sourceIndex < telemetry.length; sourceIndex++) {
      const p = telemetry[sourceIndex];
      const dx = (semanticNumber(p, "motion.position-x") ?? 0) - cx;
      const dz = (semanticNumber(p, "motion.position-z") ?? 0) - cz;
      let inRange = dx * dx + dz * dz <= maxDist2;
      let localFwd = 0,
        localLat = 0;
      if (inRange) {
        localFwd = dx * s + dz * c;
        localLat = dx * c - dz * s;
        if (localFwd < -BEHIND || localFwd > AHEAD || Math.abs(localLat) > 30) inRange = false;
      }
      if (inRange) {
        current.push({ sourceIndex, fwd: localFwd, lat: localLat, throttle: semanticNumber(p, "inputs.accel") ?? 0, brake: (semanticNumber(p, "inputs.brake") ?? 0) / 255 });
      } else if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length > 0) runs.push(current);

    // Compute perpendicular normals and build per-run offset lines.
    type InputRun = { id: number; pts: [number, number, number][]; cols: THREE.Color[] };
    const throttleRuns: InputRun[] = [];
    const brakeRuns: InputRun[] = [];

    const EPS = 0.02; // ignore pedal noise / off-pedal
    for (const pts of runs) {
      if (pts.length < 2) continue;
      // Pre-compute offset positions per side
      const tPos: [number, number, number][] = [];
      const bPos: [number, number, number][] = [];
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const tFwd = next.fwd - prev.fwd;
        const tLat = next.lat - prev.lat;
        const len = Math.sqrt(tFwd * tFwd + tLat * tLat) || 1;
        const nFwd = -tLat / len;
        const nLat = tFwd / len;
        const p = pts[i];
        tPos.push([p.fwd + nFwd * OFFSET, Y, p.lat + nLat * OFFSET]);
        bPos.push([p.fwd - nFwd * OFFSET, Y, p.lat - nLat * OFFSET]);
      }
      // Split into sub-runs covering only frames where the pedal is on,
      // so off-pedal stretches stay invisible instead of drawing a black line.
      const flush = (bucket: InputRun[], id: number, ptsBuf: [number, number, number][], colsBuf: THREE.Color[]) => {
        if (ptsBuf.length >= 5) bucket.push({ id, pts: ptsBuf.slice(), cols: colsBuf.slice() });
        ptsBuf.length = 0;
        colsBuf.length = 0;
      };
      const tBufP: [number, number, number][] = [];
      const tBufC: THREE.Color[] = [];
      const bBufP: [number, number, number][] = [];
      const bBufC: THREE.Color[] = [];
      let tStartIndex = -1;
      let bStartIndex = -1;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.throttle > EPS) {
          if (tBufP.length === 0) tStartIndex = p.sourceIndex;
          tBufP.push(tPos[i]);
          tBufC.push(pedalInputColor(inactiveColor, throttleColor, p.throttle));
        } else if (tBufP.length > 0) {
          flush(throttleRuns, tStartIndex, tBufP, tBufC);
        }
        if (p.brake > EPS) {
          if (bBufP.length === 0) bStartIndex = p.sourceIndex;
          bBufP.push(bPos[i]);
          bBufC.push(inactiveColor.clone().lerp(brakeColor, p.brake));
        } else if (bBufP.length > 0) {
          flush(brakeRuns, bStartIndex, bBufP, bBufC);
        }
      }
      if (tBufP.length > 0) flush(throttleRuns, tStartIndex, tBufP, tBufC);
      if (bBufP.length > 0) flush(brakeRuns, bStartIndex, bBufP, bBufC);
    }

    return { throttleRuns, brakeRuns };
  }, [telemetry, semanticNumber(packet, "motion.position-x"), semanticNumber(packet, "motion.position-z"), semanticNumber(packet, "motion.yaw")]);

  return (
    <>
      {data.throttleRuns.map((run) => (
        <Line key={`t-${run.id}`} points={run.pts} vertexColors={run.cols} lineWidth={6} transparent opacity={0.9} />
      ))}
      {data.brakeRuns.map((run) => (
        <Line key={`b-${run.id}`} points={run.pts} vertexColors={run.cols} lineWidth={6} transparent opacity={0.9} />
      ))}
    </>
  );
}
