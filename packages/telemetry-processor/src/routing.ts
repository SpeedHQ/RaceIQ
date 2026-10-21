import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryParser } from "./parser";
import { accParser } from "@raceiq/game-acc/game-parser";
import { acEvoParser } from "@raceiq/game-ac-evo/game-parser";
import { forzaParser } from "@raceiq/game-fm-2023/game-parser";
import { f1Parser } from "@raceiq/game-f1-2025/game-parser";
import { iracingParser } from "@raceiq/game-iracing/game-parser";
import { lmuParser } from "@raceiq/game-lmu/game-parser";

/** Select parser explicitly by game; parser-owned state remains caller-owned. */
export function getGameParser(gameId: GameId): TelemetryParser<any> {
  switch (gameId) {
    case "acc": return accParser;
    case "ac-evo": return acEvoParser;
    case "fm-2023": return forzaParser;
    case "f1-2025": return f1Parser;
    case "iracing": return iracingParser;
    case "lmu": return lmuParser;
  }
}
