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
  MotecCarTrackOverride,
  SynthesizeResult,
} from "./types";
import {
  MOTEC_IMPORT_LIMITATIONS,
} from "./kunos-synthesis";
import { synthesizeAccCapture } from "../games/acc/motec";
import { synthesizeAcEvoCapture } from "../games/ac-evo/motec";

/**
 * Transcodes a parsed log into a session capture for one game.
 *
 * Same shape as `synthesizeAcEvoCapture` — the capture is fed to that game's
 * ordinary import pipeline, so imported laps are built by the same lap
 * detector, sector timer and metrics code as recorded ones.
 */
type MotecSynthesizer = (
  log: LdLog,
  beacons: number[],
  override?: MotecCarTrackOverride,
) => SynthesizeResult;

export interface MotecTarget {
  gameId: GameId;
  /** Game name for the picker. Resolved from the game adapter, not restated. */
  displayName: string;
  routePrefix: string;
  /**
   * Where the client fetches this game's car roster. Pointed at rather than
   * duplicated here so per-game extras — AC Evo injects cars discovered from
   * live telemetry — keep working. Must return `{ ordinal, name, class? }[]`.
   */
  carsEndpoint: string;
  /**
   * What this transcoder cannot recover from a log, in the user's words. Shown
   * after an import: every mapping loses something, and saying so is the
   * difference between a known gap and a bug report.
   */
  limitations: readonly string[];
  synthesize: MotecSynthesizer;
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
    synthesize: synthesizeAccCapture,
  });
  targets.set("ac-evo", {
    gameId: "ac-evo",
    displayName: acEvo.displayName,
    routePrefix: acEvo.routePrefix,
    carsEndpoint: "/api/ac-evo/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    synthesize: synthesizeAcEvoCapture,
  });
}
