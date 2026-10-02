/**
 * Registry of games we can import a MoTeC `.ld` log for.
 *
 * ## Why this is a registry and not a constant
 *
 * `.ld` is a container format, not a schema: the channel names, units and
 * corner-suffix conventions inside one are chosen by whichever exporter wrote
 * it. A transcoder is therefore always *per game*, and pointing one at another
 * sim's log produces frames that parse cleanly and mean the wrong things —
 * silently. The failure mode is a plausible-looking lap, not an error.
 *
 * So the set of importable games is exactly the set of transcoders someone has
 * written and checked against a real export from that game. Today that is AC
 * Evo and ACC. The registry exists so the second one is an entry rather than
 * an excavation: nothing outside this file — no route, no component — names a
 * game.
 *
 * ## Adding a game
 *
 * 1. Write `server/games/<game>/motec.ts` exporting a `synthesize`-shaped
 *    function and a limitations list, modelled on `server/games/ac-evo/motec.ts`.
 * 2. Add the target to the registry in {@link initMotecTargets}.
 * 3. Nothing else. The import route validates against the registry and the
 *    client surfaces only the selected game's matching target.
 *
 * Do NOT register a game whose export has not actually been inspected. An
 * unverified mapping is worse than an unsupported one, because the user cannot
 * tell it went wrong.
 */

import type { GameId } from "../../shared/games/ids";
import { getGame } from "@shared/games/registry";
import type { LdLog } from "./ld";
import type {
  MotecCarTrack,
  MotecCarTrackOverride,
  MotecConversionResult,
} from "./types";
import { MOTEC_IMPORT_LIMITATIONS } from "./kunos-synthesis";
import {
  convertAccMotecToPackets,
  resolveAccMotecCarTrack,
} from "../games/acc/motec";
import { convertAcEvoMotecToPackets } from "../games/ac-evo/motec";
import { getAcEvoCarByModel, getAcEvoCarName } from "../../shared/racing/cars/ac-evo";
import {
  getAcEvoTrackByName,
  getAcEvoTrackBySetupFolder,
  getAcEvoTracks,
} from "../../shared/racing/tracks/catalogs/ac-evo";

type MotecConverter = (
  log: LdLog,
  beacons: number[],
  carTrack: MotecCarTrack,
) => MotecConversionResult;

export interface MotecTarget {
  gameId: GameId;
  displayName: string;
  routePrefix: string;
  carsEndpoint: string;
  limitations: readonly string[];
  convert: MotecConverter;
  resolveCarTrack: (
    log: LdLog,
    override?: MotecCarTrackOverride,
  ) => MotecCarTrack;
}

const targets = new Map<GameId, MotecTarget>();


/** All importable games, in registration order. */
export function getMotecTargets(): MotecTarget[] {
  return [...targets.values()];
}

export function tryGetMotecTarget(gameId: string): MotecTarget | undefined {
  return targets.get(gameId as GameId);
}

/**
 * Resolve targets only through explicit game identity at call sites.
 */
function resolveAcEvoMotecCarTrack(
  log: LdLog,
  override?: MotecCarTrackOverride,
): MotecCarTrack {
  const car =
    override?.carOrdinal !== undefined && override.carOrdinal >= 0
      ? { id: override.carOrdinal, name: getAcEvoCarName(override.carOrdinal) }
      : getAcEvoCarByModel(log.vehicleId);
  const track =
    override?.trackOrdinal !== undefined && override.trackOrdinal >= 0
      ? getAcEvoTracks().get(override.trackOrdinal)
      : getAcEvoTrackBySetupFolder(log.venue) ?? getAcEvoTrackByName(log.venue);
  return {
    carOrdinal: car?.id ?? -1,
    trackOrdinal: track?.id ?? -1,
    carModel: car?.name ?? log.vehicleId,
    trackName: track?.commonTrackName ?? log.venue,
  };
}


let initialised = false;
export function initMotecTargets(): void {
  if (initialised) return;
  initialised = true;
  const acEvo = getGame("ac-evo");
  const acc = getGame("acc");

  targets.set("acc", {
    gameId: "acc",
    displayName: acc.displayName,
    routePrefix: acc.routePrefix,
    carsEndpoint: "/api/acc/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    convert: convertAccMotecToPackets,
    resolveCarTrack: resolveAccMotecCarTrack,
  });
  targets.set("ac-evo", {
    gameId: "ac-evo",
    displayName: acEvo.displayName,
    routePrefix: acEvo.routePrefix,
    carsEndpoint: "/api/ac-evo/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    convert: convertAcEvoMotecToPackets,
    resolveCarTrack: resolveAcEvoMotecCarTrack,
  });
}
/**
 * Resolve explicitly selected game transcoder.
 */
export function resolveMotecTarget(gameId: string): MotecTarget {
  initMotecTargets();
  const target = tryGetMotecTarget(gameId);
  if (!target) throw new Error(`No MoTeC transcoder for game '${gameId}'`);
  return target;
}
