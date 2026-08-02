import type { TelemetryPacket } from "../../shared/types";

/**
 * Apply adapter-specific runtime normalization to one packet in one pass.
 */
export function normalizeTelemetryPacket(
  packet: TelemetryPacket,
  standardXyz: boolean,
  suspensionRange?: SuspensionTravelRangeMm,
): void {
  if (standardXyz) {
    packet.PositionX = -packet.PositionX;
    packet.VelocityX = -packet.VelocityX;
    packet.AccelerationX = -packet.AccelerationX;
  }
  fillNormSuspension(packet, suspensionRange);
}

/**
 * Compute normalized suspension travel when a source only supplies absolute
 * spring travel. The adapter owns the appropriate millimeter range.
 */
const DEFAULT_SUSPENSION_RANGE_MM = { min: 20, max: 80 };

export interface SuspensionTravelRangeMm {
  min: number;
  max: number;
}

function normalizeSuspensionTravel(value: number, min: number, span: number): number {
  return Math.max(0, Math.min(1, (value * 1000 - min) / span));
}

export function fillNormSuspension(
  packet: TelemetryPacket,
  range: SuspensionTravelRangeMm = DEFAULT_SUSPENSION_RANGE_MM,
): void {
  if (packet.NormSuspensionTravelFL !== 0 || packet.SuspensionTravelMFL <= 0) return;
  const { min, max } = range;
  const span = max - min;
  packet.NormSuspensionTravelFL = normalizeSuspensionTravel(
    packet.SuspensionTravelMFL,
    min,
    span,
  );
  packet.NormSuspensionTravelFR = normalizeSuspensionTravel(
    packet.SuspensionTravelMFR,
    min,
    span,
  );
  packet.NormSuspensionTravelRL = normalizeSuspensionTravel(
    packet.SuspensionTravelMRL,
    min,
    span,
  );
  packet.NormSuspensionTravelRR = normalizeSuspensionTravel(
    packet.SuspensionTravelMRR,
    min,
    span,
  );
}
