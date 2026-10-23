/**
 * Game tire-temperature knowledge bridge.
 *
 * Renders the optimal core/carcass windows published by game metadata as
 * prompt prose. The values live in each game adapter (`tireCoreTempOptimal`);
 * this module only formats them for AI prompts and tools.
 */
import type { GameId } from "@raceiq/shared/games/ids";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { getTireCoreTempGuide } from "@raceiq/shared/racing/live/tire-thresholds";

/** One line per compound, or an empty string when the game has no core-temperature metadata. */
export function formatTireTempGuide(gameId: GameId): string {
  const guide = getTireCoreTempGuide(gameId);
  if (guide.length === 0) return "";
  const name = tryGetGame(gameId)?.displayName ?? gameId;
  const rows = guide.map((entry) => `${entry.compound}: ${entry.min}-${entry.max} °C`).join("; ");
  return `${name} optimal tire core temperature — ${rows}. Laps below the minimum count as cold tires.`;
}
