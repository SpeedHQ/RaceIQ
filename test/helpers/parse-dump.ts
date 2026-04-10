import type { GameId, TelemetryPacket } from "../../shared/types";
import type { CapturedLap, CapturedSession } from "../../server/pipeline-adapters";
import type { LapSavedNotification } from "../../server/lap-detector";
import { CapturingDbAdapter, CapturingWsAdapter } from "../../server/pipeline-adapters";
import { Pipeline } from "../../server/pipeline";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { readUdpDump } from "./recording";
import { readAccFrames } from "../../server/games/acc/recorder";
import { parseAccBuffers } from "../../server/games/acc/parser";
import { readWString } from "../../server/games/acc/utils";
import { STATIC } from "../../server/games/acc/structs";
import { getAccCarByModel } from "../../shared/acc-car-data";
import { getAccTrackByName } from "../../shared/acc-track-data";

let _initialized = false;
export function ensureInit(): void {
  if (_initialized) return;
  initGameAdapters();
  initServerGameAdapters();
  _initialized = true;
}

export interface DumpResult {
  laps: CapturedLap[];
  sessions: CapturedSession[];
  carModel: string | null;
  trackName: string | null;
  wsNotifications: (LapSavedNotification | Record<string, unknown>)[];
  wsDevStates: Record<string, unknown>[];
  rawPackets: TelemetryPacket[];
}

export interface ParsedFrames {
  packets: TelemetryPacket[];
  carModel: string | null;
  trackName: string | null;
}

/**
 * Read all packets from an ACC recording. Exported for reuse by parseDumpV2.
 */
export function readAccPackets(dumpPath: string): ParsedFrames {
  let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
  try {
    frames = readAccFrames(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  let carModel: string | null = null;
  let trackName: string | null = null;
  let carOrdinal = 0;
  let trackOrdinal = 0;
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    if (carOrdinal === 0 || trackOrdinal === 0) {
      const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
      const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
      if (cm) { carModel = cm; carOrdinal = getAccCarByModel(cm)?.id ?? 0; }
      if (tn) { trackName = tn; trackOrdinal = getAccTrackByName(tn)?.id ?? 0; }
    }
    const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
    if (packet) packets.push(packet);
  }
  return { packets, carModel, trackName };
}

/**
 * Read all packets from a UDP dump. Exported for reuse by parseDumpV2.
 */
export function readUdpPackets(dumpPath: string): ParsedFrames {
  let buffers: Buffer[];
  try {
    buffers = readUdpDump(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  if (buffers.length === 0) return { packets: [], carModel: null, trackName: null };
  const serverAdapter = getAllServerGames().find((a) => a.canHandle(buffers[0]));
  if (!serverAdapter) return { packets: [], carModel: null, trackName: null };
  const parserState = serverAdapter.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  for (const buf of buffers) {
    const packet = serverAdapter.tryParse(buf, parserState);
    if (packet) packets.push(packet);
  }
  return { packets, carModel: null, trackName: null };
}

/**
 * Feed a recorded dump through the full server pipeline and return all captured laps, sessions, and WebSocket events.
 * Uses CapturingDbAdapter (no real DB writes) and CapturingWsAdapter (captures all WS events).
 *
 * @param gameId   The game the dump was recorded for
 * @param dumpPath Path to the dump.bin file
 */
export async function parseDump(
  gameId: GameId,
  dumpPath: string
): Promise<DumpResult> {
  ensureInit();

  const db = new CapturingDbAdapter();
  const ws = new CapturingWsAdapter();
  const pipeline = new Pipeline(db, ws, { bypassPacketRateFilter: true });

  let carModel: string | null = null;
  let trackName: string | null = null;

  if (gameId === "acc") {
    const parsed = readAccPackets(dumpPath);
    carModel = parsed.carModel;
    trackName = parsed.trackName;
    for (const packet of parsed.packets) {
      await pipeline.processPacket(packet);
    }
  } else {
    const parsed = readUdpPackets(dumpPath);
    if (parsed.packets.length === 0) return { laps: [], sessions: [], carModel: null, trackName: null, wsNotifications: [], wsDevStates: [], rawPackets: [] };
    for (const packet of parsed.packets) {
      await pipeline.processPacket(packet);
    }
  }

  // End of recording — flush any in-progress lap as incomplete (v2 only; v1 no-op)
  await pipeline.flushIncompleteLap();

  // Flush deferred insertLap calls (lap-detector uses setTimeout(..., 0))
  await new Promise<void>((r) => setTimeout(r, 0));

  // Extract raw packets from broadcast events (all packets that went through the pipeline)
  const rawPackets = ws.broadcastedPackets.map((e) => e.packet);

  return {
    laps: db.laps,
    sessions: db.sessions,
    carModel,
    trackName,
    wsNotifications: ws.broadcastedNotifications,
    wsDevStates: ws.broadcastedDevStates,
    rawPackets,
  };
}
