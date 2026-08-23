import { getGame } from "@shared/games/registry";
import { isGearingSampleValid } from "@shared/games/telemetry";
import type { GearingSample } from "./gearing-telemetry";

/**
 * Check whether a telemetry sample is clean enough to be used for
 * power-curve accumulation. Rules resolve from the game adapter's
 * declared `telemetry.gearing` semantics; games without declared rules
 * accept every sample.
 */
export function isSampleValid(packet: GearingSample): boolean {
  return isGearingSampleValid(packet, getGame(packet.gameId).telemetry);
}
