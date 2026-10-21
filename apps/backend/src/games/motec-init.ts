import { getGame } from "@raceiq/shared/games/registry";
import { convertAcEvoMotecToPackets, resolveAcEvoMotecCarTrack } from "@raceiq/game-ac-evo/motec";
import { convertAccMotecToPackets, resolveAccMotecCarTrack } from "@raceiq/game-acc/motec";
import { MOTEC_IMPORT_LIMITATIONS } from "@raceiq/backend-core/motec/kunos-synthesis";
import { registerMotecTarget } from "@raceiq/backend-core/motec/targets";

let initialised = false;

export function initMotecTargets(): void {
  if (initialised) return;
  initialised = true;
  const acEvo = getGame("ac-evo");
  const acc = getGame("acc");

  registerMotecTarget({
    gameId: "acc",
    displayName: acc.displayName,
    routePrefix: acc.routePrefix,
    carsEndpoint: "/api/acc/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    convert: convertAccMotecToPackets,
    resolveCarTrack: resolveAccMotecCarTrack,
  });
  registerMotecTarget({
    gameId: "ac-evo",
    displayName: acEvo.displayName,
    routePrefix: acEvo.routePrefix,
    carsEndpoint: "/api/ac-evo/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    convert: convertAcEvoMotecToPackets,
    resolveCarTrack: resolveAcEvoMotecCarTrack,
  });
}
