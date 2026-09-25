import { Line } from "@react-three/drei";
import { useMemo } from "react";
import { semanticNumber, type SemanticAnalysisFrame } from "../analyse/track-map/types";
import { buildTrackIndex, filterByDistanceIndexed, pedalInputColor, threeColor, type TrackIndex } from "../../lib/wireframe-utils";

export type InputRun = {
  id: number;
  pts: [number, number, number][];
  values: number[];
};

export function buildInputOverlayRuns(
  telemetry: SemanticAnalysisFrame[],
  index: TrackIndex,
  packet: SemanticAnalysisFrame,
): { throttleRuns: InputRun[]; brakeRuns: InputRun[] } {
  const cx = semanticNumber(packet, "motion.position-x") ?? 0;
  const cz = semanticNumber(packet, "motion.position-z") ?? 0;
  const yaw = semanticNumber(packet, "motion.yaw") ?? 0;
  const segments = filterByDistanceIndexed(index, cx, cz, yaw, -0.44, 60, 20, 30);
  const EPS = 0.02;
  const OFFSET = 0.1;
  const throttleRuns: InputRun[] = [];
  const brakeRuns: InputRun[] = [];

  for (const segment of segments) {
    const sourcePoints = segment.points.map((point, offset) => {
      const sourceIndex = segment.sourceStartIndex + offset;
      const frame = telemetry[sourceIndex];
      return { sourceIndex, point, throttle: semanticNumber(frame, "inputs.accel") ?? 0, brake: (semanticNumber(frame, "inputs.brake") ?? 0) / 255 };
    });
    const throttlePts: [number, number, number][] = [];
    const throttleValues: number[] = [];
    const brakePts: [number, number, number][] = [];
    const brakeValues: number[] = [];
    let throttleStart = -1;
    let brakeStart = -1;
    const flush = (bucket: InputRun[], id: number, pts: [number, number, number][], values: number[]) => {
      if (pts.length >= 5) bucket.push({ id, pts: pts.slice(), values: values.slice() });
      pts.length = 0;
      values.length = 0;
    };

    for (let i = 0; i < sourcePoints.length; i++) {
      const { sourceIndex, point, throttle, brake } = sourcePoints[i];
      const prev = sourcePoints[Math.max(0, i - 1)].point;
      const next = sourcePoints[Math.min(sourcePoints.length - 1, i + 1)].point;
      const tFwd = next[0] - prev[0];
      const tLat = next[2] - prev[2];
      const length = Math.sqrt(tFwd * tFwd + tLat * tLat) || 1;
      const nFwd = -tLat / length;
      const nLat = tFwd / length;
      if (throttle > EPS) {
        if (throttlePts.length === 0) throttleStart = sourceIndex;
        throttlePts.push([point[0] + nFwd * OFFSET, point[1], point[2] + nLat * OFFSET]);
        throttleValues.push(throttle);
      } else if (throttlePts.length > 0) {
        flush(throttleRuns, throttleStart, throttlePts, throttleValues);
      }
      if (brake > EPS) {
        if (brakePts.length === 0) brakeStart = sourceIndex;
        brakePts.push([point[0] - nFwd * OFFSET, point[1], point[2] - nLat * OFFSET]);
        brakeValues.push(brake);
      } else if (brakePts.length > 0) {
        flush(brakeRuns, brakeStart, brakePts, brakeValues);
      }
    }
    if (throttlePts.length > 0) flush(throttleRuns, throttleStart, throttlePts, throttleValues);
    if (brakePts.length > 0) flush(brakeRuns, brakeStart, brakePts, brakeValues);
  }
  return { throttleRuns, brakeRuns };
}

export function InputOverlay({ telemetry, packet }: { telemetry: SemanticAnalysisFrame[]; packet: SemanticAnalysisFrame }) {
  const points = useMemo(() => telemetry.map((frame) => ({
    x: semanticNumber(frame, "motion.position-x") ?? 0,
    z: semanticNumber(frame, "motion.position-z") ?? 0,
  })), [telemetry]);
  const index = useMemo(() => buildTrackIndex(points), [points]);
  const runs = useMemo(
    () => buildInputOverlayRuns(telemetry, index, packet),
    [telemetry, index, semanticNumber(packet, "motion.position-x"), semanticNumber(packet, "motion.position-z"), semanticNumber(packet, "motion.yaw")],
  );
  const data = useMemo(() => {
    const throttleColor = threeColor("var(--ch-throttle)");
    const brakeColor = threeColor("var(--ch-brake)");
    const inactiveColor = threeColor("var(--app-bg)");
    return {
      throttleRuns: runs.throttleRuns.map((run) => ({ ...run, cols: run.values.map((value) => pedalInputColor(inactiveColor, throttleColor, value)) })),
      brakeRuns: runs.brakeRuns.map((run) => ({ ...run, cols: run.values.map((value) => pedalInputColor(inactiveColor, brakeColor, value * 255)) })),
    };
  }, [runs]);

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
