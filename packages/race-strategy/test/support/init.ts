import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { registerGame } from "@raceiq/shared/games/registry";
import { forzaServerAdapter } from "@raceiq/game-fm-2023";
import { f1ServerAdapter } from "@raceiq/game-f1-2025";
import { accServerAdapter } from "@raceiq/game-acc";
import { registerRaceStrategyFeature } from "@raceiq/race-strategy/server";

/** Register only the real adapters required by the feature's integration suites. */
export function initStrategyTestAdapters(): void {
  initGameAdapters();
  registerRaceStrategyFeature();
  for (const adapter of [forzaServerAdapter, f1ServerAdapter, accServerAdapter]) {
    registerServerGame(adapter);
    registerGame(adapter);
  }
}
