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
 * written and checked against a real export from that game. Today that is one
 * (AC Evo). The registry exists so the second one is an entry rather than an
 * excavation: nothing outside this file — no route, no component — names a
 * game.
 *
 * ## Adding a game
 *
 * 1. Write `server/games/<game>/motec.ts` exporting a `synthesize`-shaped
 *    function and a limitations list, modelled on `server/games/ac-evo/motec.ts`.
 * 2. Add a {@link registerMotecTarget} call in {@link initMotecTargets}.
 * 3. Nothing else. The import route validates against the registry and the
 *    client dialog renders a game picker on its own once there is more than one.
 *
 * Do NOT register a game whose export has not actually been inspected. An
 * unverified mapping is worse than an unsupported one, because the user cannot
 * tell it went wrong.
 */

import type { GameId } from "@shared/types";
import { getGame } from "@shared/games/registry";
import type { LdLog } from "./ld";
import {
  type MotecCarTrackOverride,
  type SynthesizeResult,
} from "./types";
import {
  MOTEC_IMPORT_LIMITATIONS,
  synthesizeAcEvoCapture,
} from "../games/ac-evo/motec";

/**
 * Transcodes a parsed log into a session capture for one game.
 *
 * Same shape as `synthesizeAcEvoCapture` — the capture is fed to that game's
 * ordinary import pipeline, so imported laps are built by the same lap
 * detector, sector timer and metrics code as recorded ones.
 */
export type MotecSynthesizer = (
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

export function registerMotecTarget(target: MotecTarget): void {
  targets.set(target.gameId, target);
}

/** All importable games, in registration order. */
export function getMotecTargets(): MotecTarget[] {
  return [...targets.values()];
}

export function tryGetMotecTarget(gameId: string): MotecTarget | undefined {
  return targets.get(gameId as GameId);
}

/**
 * The game an import lands in when the caller names none.
 *
 * Only defined while exactly one transcoder exists — with a single choice the
 * dialog shows no picker and sends no gameId, and inventing a default is the
 * whole point. The moment a second game is registered this returns undefined
 * and the route demands an explicit choice, because guessing which sim a `.ld`
 * came from is precisely the mistake this module exists to prevent.
 */
export function getDefaultMotecTarget(): MotecTarget | undefined {
  return targets.size === 1 ? targets.values().next().value : undefined;
}

let initialised = false;

export function initMotecTargets(): void {
  if (initialised) return;
  initialised = true;

  registerMotecTarget({
    gameId: "ac-evo",
    displayName: getGame("ac-evo").displayName,
    routePrefix: getGame("ac-evo").routePrefix,
    carsEndpoint: "/api/ac-evo/cars",
    limitations: MOTEC_IMPORT_LIMITATIONS,
    synthesize: synthesizeAcEvoCapture,
  });
}
