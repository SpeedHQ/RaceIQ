import type { GearingSample } from "./gearing-telemetry";

/**
 * Check whether a telemetry sample is clean enough to be used for
 * power-curve accumulation.  Rules are game-specific because different
 * titles expose different input ranges.
 */
export function isSampleValid(packet: GearingSample): boolean {

  switch (packet.gameId) {
    case "fm-2023":
      if(packet.IsRaceOn <= 0) return false; // Not in session
      if(packet.Gear === 0) return false; // Neutral - no power transfer
      if(packet.Gear === 11) return false; // Reverse - telemetry is noisy and power curve isn't useful
      return true;
    // Future: add ACC and F1 2025 rules here
    default:
      return true; // Be optimistic about unknown games until we have data to define rules
  }
  
}
