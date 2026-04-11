import type { TelemetryPacket } from "../shared/types";

/**
 * Compute NormSuspensionTravel from SuspensionTravelM for games that
 * don't provide it natively (F1, ACC). Forza provides it directly.
 *
 * Ranges are in millimetres of absolute spring travel. ACC GT3 cars
 * typically report ~10-45mm, so the previous shared 20-80mm range
 * clamped most samples to 0-5%.
 */
const SUSPENSION_RANGE_MM: Record<string, { min: number; max: number }> = {
  "acc": { min: 0, max: 50 },
  "f1-2025": { min: 20, max: 80 },
};
const DEFAULT_SUSPENSION_RANGE_MM = { min: 20, max: 80 };

export function fillNormSuspension(p: TelemetryPacket): void {
  if (p.NormSuspensionTravelFL !== 0 || p.SuspensionTravelMFL <= 0) return;
  const { min, max } = SUSPENSION_RANGE_MM[p.gameId ?? ""] ?? DEFAULT_SUSPENSION_RANGE_MM;
  const span = max - min;
  const norm = (v: number) => Math.max(0, Math.min(1, (v * 1000 - min) / span));
  p.NormSuspensionTravelFL = norm(p.SuspensionTravelMFL);
  p.NormSuspensionTravelFR = norm(p.SuspensionTravelMFR);
  p.NormSuspensionTravelRL = norm(p.SuspensionTravelMRL);
  p.NormSuspensionTravelRR = norm(p.SuspensionTravelMRR);
}
