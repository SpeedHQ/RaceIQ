import { normalizeSuspensionTravel } from "../../lib/suspension";
import { type SemanticAnalysisFrame, semanticNumber } from "../analyse/track-map/types";

function normalizedSuspension(frame: SemanticAnalysisFrame, range?: { min: number; max: number }): [number, number, number, number] {
  const normalized = frame.values["suspension.norm-suspension-travel"];
  if (Array.isArray(normalized) && normalized.length >= 4 && normalized.slice(0, 4).every((value) => typeof value === "number" && Number.isFinite(value))) {
    return normalized.slice(0, 4) as [number, number, number, number];
  }
  return normalizeSuspensionTravel(frame.values["suspension.suspension-travel-m"] as unknown[], range);
}

// Baseline-subtracted weighted centroid; max compression controls displacement.
function computeLoadDotXZ(susp: [number, number, number, number], wb: number, ft: number, rt: number): { x: number; z: number } {
  const base = Math.min(susp[0], susp[1], susp[2], susp[3]);
  const maxC = Math.max(susp[0], susp[1], susp[2], susp[3]);
  const w0 = susp[0] - base;
  const w1 = susp[1] - base;
  const w2 = susp[2] - base;
  const w3 = susp[3] - base;
  const total = w0 + w1 + w2 + w3;
  if (total < 1e-4) return { x: 0, z: 0 };
  const dirX = (wb * (w0 + w1) - wb * (w2 + w3)) / total;
  const dirZ = ((-ft + 0.35) * w0 + (ft - 0.35) * w1 + (-rt + 0.35) * w2 + (rt - 0.35) * w3) / total;
  return { x: dirX * Math.min(1, maxC), z: dirZ * Math.min(1, maxC) };
}

/** Retain bounded, ordered one-second load-centroid history for render consumers. */
export function buildLoadTrail(
  telemetry: SemanticAnalysisFrame[],
  cursorIdx: number,
  suspensionRange: { min: number; max: number } | undefined,
  wb: number,
  ft: number,
  rt: number,
): Array<[number, number]> {
  const cur = telemetry[cursorIdx];
  if (!cur) return [];
  const endLap = semanticNumber(cur, "timing.current-lap") ?? 0;
  const points: Array<[number, number]> = [];
  for (let i = cursorIdx; i >= 0 && cursorIdx - i < 64; i--) {
    const frame = telemetry[i];
    if (!frame) break;
    const lap = semanticNumber(frame, "timing.current-lap") ?? 0;
    if (lap > endLap || endLap - lap > 1) break;
    const dot = computeLoadDotXZ(normalizedSuspension(frame, suspensionRange), wb, ft, rt);
    points.push([dot.x, dot.z]);
  }
  return points.reverse();
}
