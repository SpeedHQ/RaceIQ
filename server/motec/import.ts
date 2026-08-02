/**
 * MoTeC `.ld` import entry point.
 *
 * Transcodes the log to an AC Evo session capture (see `../games/ac-evo/motec.ts`) and feeds
 * it through the ordinary import pipeline, so imported laps are built by the
 * same lap detector, sector timer and metrics code as recorded ones — and are
 * re-materialisable afterwards, because the pipeline's recorder persists the
 * frames it was given.
 *
 * The only thing that marks them out is `sessions.source = 'motec'`, stamped
 * after the fact so the pipeline's own signatures stay untouched.
 *
 * ## One transcoder per game
 *
 * `.ld` is a container format, not a schema: the channel names, units and
 * corner-suffix conventions inside one are chosen by whichever exporter wrote
 * it. The mapping in `../games/ac-evo/motec.ts` was derived from an AC Evo export and has
 * only ever been checked against one. Pointing it at an iRacing or rFactor log
 * would produce frames that parse cleanly and mean the wrong things — silently.
 *
 * So this file is game-agnostic and knows nothing about AC Evo: which games can
 * be imported, and how each is transcoded, lives in `targets.ts`. Adding a game
 * is an entry there.
 */

import { db } from "../db";
import { laps as laps_, sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { MOTEC_SESSION_SOURCE } from "@shared/motec";
import { importSessionBin } from "../session-capture/import-capture";
import type { ImportedLap } from "../session-capture/import-pipeline";
import { parseLd } from "./ld";
import { parseLdxBeacons } from "./ldx";
import type { MotecCarTrack } from "./types";
import {
  getDefaultMotecTarget,
  initMotecTargets,
  tryGetMotecTarget,
  type MotecTarget,
} from "./targets";

export { MOTEC_SESSION_SOURCE };

/**
 * Resolve the game an import should land in.
 *
 * Throws rather than falling back to a game: filing a log against the wrong
 * sim's transcoder is the one failure this module cannot detect afterwards.
 */
export function resolveMotecTarget(gameId?: string): MotecTarget {
  initMotecTargets();
  if (gameId !== undefined) {
    const target = tryGetMotecTarget(gameId);
    if (!target) throw new Error(`No MoTeC transcoder for game '${gameId}'`);
    return target;
  }
  const only = getDefaultMotecTarget();
  if (!only) throw new Error("gameId is required: more than one game can be imported");
  return only;
}

export interface MotecImportResult {
  gameId: string;
  laps: ImportedLap[];
  packetCount: number;
  lapCount: number;
  carTrack: MotecCarTrack;
  /** Log header fields, for showing the user what they just imported. */
  meta: {
    driver: string;
    venue: string;
    vehicleId: string;
    date: string;
    time: string;
    duration: number;
  };
  missingChannels: string[];
  yawFromLateralG: boolean;
  limitations: readonly string[];
}

export interface MotecImportOptions {
  /**
   * Which game's transcoder to run the log through. Optional only while a
   * single game is registered — see {@link resolveMotecTarget}.
   */
  gameId?: string;
  /**
   * Car and track the log was driven on, as chosen by the user. Takes priority
   * over the log header — see `resolveMotecCarTrack` for why the header is only
   * a hint.
   */
  carOrdinal?: number;
  trackOrdinal?: number;
  /**
   * Optional setup the stint was run on, as a `tunes` row id. Stamped onto every
   * imported lap so the laps sit in the same comparison scope as recorded laps
   * on that setup. Left null when the driver doesn't know or doesn't care —
   * unlike car and track, an absent setup costs nothing but a missing label.
   */
  tuneId?: number;
}

/**
 * Import a MoTeC `.ld` log, optionally with its `.ldx` sidecar.
 *
 * Without the sidecar the log is treated as one unsplit stint — that is the
 * honest reading, since lap beacons live only in the `.ldx`, and AC Evo's
 * exporter writes an empty beacon group for a standalone hotlap anyway.
 */
export async function importMotec(
  ldBytes: Buffer,
  ldxText?: string,
  options?: MotecImportOptions,
): Promise<MotecImportResult> {
  const target = resolveMotecTarget(options?.gameId);
  const log = parseLd(new Uint8Array(ldBytes));
  const beacons = ldxText ? parseLdxBeacons(ldxText) : [];

  const capture = target.synthesize(log, beacons, {
    carOrdinal: options?.carOrdinal,
    trackOrdinal: options?.trackOrdinal,
  });
  const { packetCount, laps } = await importSessionBin(capture.bin, target.gameId);

  // Stamp every session the import touched. Normally one, but the pipeline
  // rotates sessions on a car/track change, so don't assume.
  const sessionIds = [...new Set(laps.map((l) => l.sessionId))];
  for (const sessionId of sessionIds) {
    await db
      .update(sessions)
      .set({ source: MOTEC_SESSION_SOURCE })
      .where(eq(sessions.id, sessionId));
  }

  // The pipeline resolves a lap's tune from the live tune assignment, which an
  // import has no business touching, so the chosen setup is applied afterwards.
  if (options?.tuneId !== undefined) {
    for (const lap of laps) {
      await db.update(laps_).set({ tuneId: options.tuneId }).where(eq(laps_.id, lap.lapId));
    }
  }

  return {
    gameId: target.gameId,
    laps,
    packetCount,
    lapCount: capture.lapCount,
    carTrack: capture.carTrack,
    meta: {
      driver: log.driver,
      venue: log.venue,
      vehicleId: log.vehicleId,
      date: log.date,
      time: log.time,
      duration: log.duration,
    },
    missingChannels: capture.missingChannels,
    yawFromLateralG: capture.yawFromLateralG,
    limitations: target.limitations,
  };
}
