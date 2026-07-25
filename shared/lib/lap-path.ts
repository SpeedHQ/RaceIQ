import type { TelemetryPacket } from "../types";

/**
 * Check if telemetry has valid world positions (not all zeros).
 * Samples a spread of ~20 packets rather than every frame.
 */
export function hasWorldPositions(telemetry: TelemetryPacket[]): boolean {
  for (let i = 0; i < Math.min(telemetry.length, 20); i++) {
    const idx = Math.floor((i * telemetry.length) / 20);
    if (telemetry[idx].PositionX !== 0 || telemetry[idx].PositionZ !== 0) return true;
  }
  return false;
}

/**
 * Integrate positions from velocity when world positions aren't available.
 */
export function integratePositions(packets: TelemetryPacket[]): { x: number[]; z: number[] } {
  const x: number[] = [0];
  const z: number[] = [0];
  for (let i = 1; i < packets.length; i++) {
    const dt = (packets[i].TimestampMS - packets[i - 1].TimestampMS) / 1000;
    if (dt <= 0 || dt > 1) {
      x.push(x[x.length - 1]);
      z.push(z[z.length - 1]);
      continue;
    }
    x.push(x[x.length - 1] + packets[i].VelocityX * dt);
    z.push(z[z.length - 1] + packets[i].VelocityZ * dt);
  }
  return { x, z };
}

/**
 * Resolve a lap's {x,z} path: use world positions when present, otherwise
 * integrate from velocity.
 */
export function lapPath(packets: TelemetryPacket[]): { x: number[]; z: number[] } {
  if (hasWorldPositions(packets)) {
    return { x: packets.map((p) => p.PositionX), z: packets.map((p) => p.PositionZ) };
  }
  return integratePositions(packets);
}
