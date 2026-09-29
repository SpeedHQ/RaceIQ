import type { TelemetryPacket } from "../../shared/telemetry/types";

/** Return source-reported validity when packet carries an explicit supported signal. */
export function recordedLapValidity(packet: TelemetryPacket | undefined): boolean | null {
  if (!packet) return null;
  if (packet.f1?.currentLapInvalid === 0) return true;
  if (packet.f1?.currentLapInvalid === 1) return false;
  return packet.acc?.isValidLap ?? null;
}
