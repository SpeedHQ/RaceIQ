import type { GameId } from "../../shared/games/ids";
import type { TelemetryDerivation } from "../../shared/telemetry/derivations/contracts";
import { ACC_RACE_EVENT_DERIVATIONS } from "./acc/race-event-semantics";
import { AC_EVO_RACE_EVENT_DERIVATIONS } from "./ac-evo/race-event-semantics";
import { F1_RACE_EVENT_DERIVATIONS } from "./f1-2025/race-event-semantics";
import { IRACING_RACE_EVENT_DERIVATIONS } from "./iracing/race-event-semantics";

export interface GameRaceEventDerivationRegistryEntry {
  readonly artifact: string;
  readonly derivations: readonly TelemetryDerivation[];
}

export const GAME_RACE_EVENT_DERIVATIONS: Readonly<
  Record<GameId, GameRaceEventDerivationRegistryEntry>
> = {
  "fm-2023": {
    artifact: "server/games/fm-2023/race-event-semantics.ts",
    derivations: [],
  },
  "f1-2025": {
    artifact: "server/games/f1-2025/race-event-semantics.ts",
    derivations: F1_RACE_EVENT_DERIVATIONS,
  },
  acc: {
    artifact: "server/games/acc/race-event-semantics.ts",
    derivations: ACC_RACE_EVENT_DERIVATIONS,
  },
  "ac-evo": {
    artifact: "server/games/ac-evo/race-event-semantics.ts",
    derivations: AC_EVO_RACE_EVENT_DERIVATIONS,
  },
  iracing: {
    artifact: "server/games/iracing/race-event-semantics.ts",
    derivations: IRACING_RACE_EVENT_DERIVATIONS,
  },
};

export function getGameRaceEventDerivation(
  gameId: GameId,
  semanticId: string,
): TelemetryDerivation | undefined {
  return GAME_RACE_EVENT_DERIVATIONS[gameId].derivations.find(
    (derivation) => derivation.output.semanticId === semanticId,
  );
}
