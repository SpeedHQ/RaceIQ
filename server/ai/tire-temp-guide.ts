/**
 * Game tire-temperature knowledge bridge.
 *
 * Renders the optimal working windows published by game metadata as prompt
 * prose. The values live in each game adapter (`tireTempOptimal`); this module
 * only formats them for AI prompts and tools.
 */
import type { GameId } from "@raceiq/shared/games/ids";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { getTireTempGuide } from "@raceiq/shared/racing/live/tire-thresholds";

/** One line per compound, or an empty string when the game publishes no window. */
export function formatTireTempGuide(gameId: GameId): string {
  const guide = getTireTempGuide(gameId);
  if (!guide) return "";
  const name = tryGetGame(gameId)?.displayName ?? gameId;
  const rows = guide.rows.map((entry) => `${entry.compound}: ${entry.min}-${entry.max} °C`).join("; ");
  // The cold-lap split only reads a carcass channel, so a surface window must not
  // claim that laps below the minimum are classified as cold.
  const coldNote = guide.channel === "carcass" ? " Laps below the minimum count as cold tires." : "";
  return `${name} optimal tire ${guide.channel} temperature — ${rows}.${coldNote}`;
}
