import type { TelemetryPacket } from "../../shared/types";

/**
 * Compute normalized suspension travel when a source only supplies absolute
 * spring travel. The adapter owns the appropriate millimeter range.
 */
const DEFAULT_SUSPENSION_RANGE_MM = { min: 20, max: 80 };

export interface SuspensionTravelRangeMm {
  min: number;
  max: number;
}

export function fillNormSuspension(
  p: TelemetryPacket,
  range: SuspensionTravelRangeMm = DEFAULT_SUSPENSION_RANGE_MM,
): void {
  if (p.NormSuspensionTravelFL !== 0 || p.SuspensionTravelMFL <= 0) return;
  const { min, max } = range;
  const span = max - min;
  const norm = (v: number) => Math.max(0, Math.min(1, (v * 1000 - min) / span));
  p.NormSuspensionTravelFL = norm(p.SuspensionTravelMFL);
  p.NormSuspensionTravelFR = norm(p.SuspensionTravelMFR);
  p.NormSuspensionTravelRL = norm(p.SuspensionTravelMRL);
  p.NormSuspensionTravelRR = norm(p.SuspensionTravelMRR);
}
