/**
 * MoTeC `.ld` import entry point.
 *
 * Transcodes the log to an AC Evo session capture (see `to-ac-evo.ts`) and feeds
 * it through the ordinary import pipeline, so imported laps are built by the
 * same lap detector, sector timer and metrics code as recorded ones — and are
 * re-materialisable afterwards, because the pipeline's recorder persists the
 * frames it was given.
 *
 * The only thing that marks them out is `sessions.source = 'motec'`, stamped
 * after the fact so the pipeline's own signatures stay untouched.
 *
 * ## AC Evo only, deliberately
 *
 * `.ld` is a container format, not a schema: the channel names, units and
 * corner-suffix conventions inside one are chosen by whichever exporter wrote
 * it. The mapping in `to-ac-evo.ts` was derived from an AC Evo export and has
 * only ever been checked against one. Pointing it at an iRacing or rFactor log
 * would produce frames that parse cleanly and mean the wrong things — silently.
 * So imports are AC Evo only until another game's export has actually been
 * inspected. {@link MOTEC_IMPORT_GAME_ID} is the single place that assumption
 * lives.
 */

import { db } from "../db";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { importSessionBin, type ImportedLap } from "../import-session-bin";
import { parseLd } from "./ld";
import { parseLdxBeacons } from "./ldx";
import {
  MOTEC_IMPORT_LIMITATIONS,
  synthesizeAcEvoCapture,
  type MotecCarTrack,
} from "./to-ac-evo";

/** Value written to `sessions.source` for a MoTeC-derived session. */
export const MOTEC_SESSION_SOURCE = "motec";

/** The only game whose MoTeC export we have verified a channel mapping for. */
export const MOTEC_IMPORT_GAME_ID = "ac-evo" as const;

export interface MotecImportResult {
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
): Promise<MotecImportResult> {
  const log = parseLd(new Uint8Array(ldBytes));
  const beacons = ldxText ? parseLdxBeacons(ldxText) : [];

  const capture = synthesizeAcEvoCapture(log, beacons);
  const { packetCount, laps } = await importSessionBin(capture.bin, MOTEC_IMPORT_GAME_ID);

  // Stamp every session the import touched. Normally one, but the pipeline
  // rotates sessions on a car/track change, so don't assume.
  const sessionIds = [...new Set(laps.map((l) => l.sessionId))];
  for (const sessionId of sessionIds) {
    await db
      .update(sessions)
      .set({ source: MOTEC_SESSION_SOURCE })
      .where(eq(sessions.id, sessionId));
  }

  return {
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
    limitations: MOTEC_IMPORT_LIMITATIONS,
  };
}
