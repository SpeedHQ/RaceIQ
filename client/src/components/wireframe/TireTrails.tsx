import { useMemo } from "react";
import { Line } from "@react-three/drei";
import type { TelemetryPacket } from "@shared/types";
import type { CarModelEnrichment } from "../../data/car-models";
import { getWheelOffsets, trailColorFromState } from "../../lib/wireframe-utils";
import { allWheelStates } from "../../lib/vehicle-dynamics";
import * as THREE from "three";

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

  // Compute traction state colors per-packet using the same logic as the data panel labels
  const slipFns = [
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFL),
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipFR),
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRL),
    (p: TelemetryPacket) => Math.abs(p.TireCombinedSlipRR),
  ];
  const wheelKeys = ["fl", "fr", "rl", "rr"] as const;

  // Only recompute trail geometry on cursor change — use pre-computed colors
  const trails = useMemo(() => {
    const cur = telemetry[cursorIdx];
    if (!cur) return null;
    // Find start index by time (consistent trail length regardless of packet rate)
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
  }, [telemetry, cursorIdx, WHEEL_OFFSETS]);

  if (!trails) return null;

  return (
    <>
      {trails.map((trail, w) => {
        const n = trail.cols.length;
        if (n < 2) return null;
        const points: [number, number, number][] = [];
        for (let i = 0; i < n; i++) points.push([trail.pts[i * 3], trail.pts[i * 3 + 1], trail.pts[i * 3 + 2]]);
        return (
          <Line key={`trail-${w}`} points={points} vertexColors={trail.cols as unknown as Array<[number, number, number]>} lineWidth={3} />
        );
      })}
    </>
  );
}
