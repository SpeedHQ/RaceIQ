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
import { laps as laps_ } from "../db/schema";
import { eq } from "drizzle-orm";
import { MOTEC_SESSION_SOURCE } from "@shared/integrations/motec";
import { importSessionBin } from "../session-capture/import-capture";
import { ImportSourceOffsetTracker, type ImportedLap } from "../session-capture/import-pipeline";
import { parseLd } from "./ld";
import { parseLdxBeacons } from "./ldx";
import type { MotecCarTrack } from "./types";
import type { SessionOwnership } from "../../shared/racing/sessions/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getGame } from "../../shared/games/registry";
import {
  unavailableAnalysisFeatures,
  type UnavailableAnalysisFeature,
} from "../../shared/games/metric-contracts";
import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { groupsById } from "../../shared/telemetry/catalog/query";
import { resolveMotecTarget } from "./targets";
import { persistMotecSourceArchive } from "./source-archive";
import { resolveTelemetryReplay } from "../telemetry/replay";
import { getServerGame } from "../games/registry";
import { iterateSessionFrameRecords } from "../session-capture/framing";
import { unlink } from "node:fs/promises";

export { MOTEC_SESSION_SOURCE };



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
  capabilities: Array<{ semanticId: string; label: string; group: string; available: boolean }>;
  unavailableFeatures: UnavailableAnalysisFeature[];
  sampleRates: Array<{ name: string; hz: number }>;
  yawFromLateralG: boolean;
  limitations: readonly string[];
}

export interface MotecImportOptions {
  /** Which game's transcoder to run the log through. */
  gameId: GameId;
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
  ownership?: SessionOwnership;
}

/**
 * Import a MoTeC `.ld` log, optionally with its `.ldx` sidecar.
 *
 * Without the sidecar the log is treated as one unsplit stint.
 */
export async function importMotec(
  ldBytes: Buffer,
  ldxBytes: Buffer | undefined,
  options: MotecImportOptions,
): Promise<MotecImportResult> {
  const target = resolveMotecTarget(options.gameId);
  const log = parseLd(ldBytes);
  const beacons = ldxBytes ? parseLdxBeacons(ldxBytes.toString("utf8")) : [];
  const capture = target.synthesize(log, beacons, {
    carOrdinal: options?.carOrdinal,
    trackOrdinal: options?.trackOrdinal,
  });
  const adapter = getGame(target.gameId);
  const semanticIds = TELEMETRY_CATALOG.variables.map((variable) => variable.id);
  const serverGame = getServerGame(target.gameId);
  const parserState = serverGame.createParserState();
  const samplePackets: TelemetryPacket[] = [];
  for (const { frame } of iterateSessionFrameRecords(capture.bin)) {
    const packet = serverGame.tryParse(frame, parserState);
    if (packet) samplePackets.push(packet);
    if (samplePackets.length === 2) break;
  }
  const semanticReplay = resolveTelemetryReplay(
    0,
    {
      id: 0,
      sessionId: 0,
      createdAt: new Date().toISOString(),
      gameId: target.gameId,
      rawFile: null,
      rawByteOffset: null,
      rawFrameCount: null,
    },
    samplePackets,
    semanticIds,
  );
  const availableSemanticIds = new Set<string>();
  for (const envelope of semanticReplay.envelopes) {
    for (const value of envelope.values) {
      if (value.state === "ok") availableSemanticIds.add(value.semanticId);
    }
  }
  const capabilities = TELEMETRY_CATALOG.variables
    .map((variable) => ({
      semanticId: variable.id,
      label: variable.label,
      group: groupsById.get(variable.parentId)?.label ?? variable.parentId,
      available: availableSemanticIds.has(variable.id),
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  const unavailableFeatures = unavailableAnalysisFeatures(adapter, availableSemanticIds);
  const sourcePath = await persistMotecSourceArchive(options.gameId, ldBytes, ldxBytes);
  let imported: { packetCount: number; laps: ImportedLap[] };
  try {
    imported = await importSessionBin(capture.bin, target.gameId, {
      ownership: options?.ownership,
      recorder: new ImportSourceOffsetTracker(sourcePath),
      sessionSource: MOTEC_SESSION_SOURCE,
      requireLaps: true,
    });
  } catch (error) {
    await unlink(sourcePath).catch(() => {});
    throw error;
  }
  const { packetCount, laps } = imported;

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
    sampleRates: capture.sampleRates,
    capabilities,
    unavailableFeatures,
    yawFromLateralG: capture.yawFromLateralG,
    limitations: target.limitations,
  };
}
