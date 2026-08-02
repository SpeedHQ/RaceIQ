import type { GameId, TelemetryPacket } from "../../shared/types";
import type { CapturedLap, CapturedSession } from "../../server/telemetry/pipeline-ports"
import type { LapSavedNotification } from "../../server/lap-detection/types"
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../server/telemetry/pipeline-ports"
import { LiveTelemetryPipeline } from "../../server/telemetry/live-pipeline"
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames, getServerGame } from "../../server/games/registry";
import { readUdpDump } from "./recording";
import { readKunosFrames } from "../../server/games/kunos/frame-reader";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { parseAccBuffers } from "../../server/games/acc/parser";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../../server/games/ac-evo/parser";
import { readWString } from "../../server/games/acc/utils";
import { STATIC } from "../../server/games/acc/structs";
import { getAccCarByModel } from "../../shared/acc-car-data";
import { getAccTrackByName } from "../../shared/acc-track-data";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing"

let _initialized = false;
export function ensureInit(): void {
  if (_initialized) return;
  initGameAdapters();
  initServerGameAdapters();
  _initialized = true;
}

/**
 * A {@link CapturedLap} after `parseDump` has attached its per-lap packets.
 * `parseDump` assigns `packets` to every lap it returns, so test code can rely
 * on it being present even though it is optional on the production type.
 */
export interface CapturedLapWithPackets extends CapturedLap {
  packets: TelemetryPacket[];
}

export interface DumpResult {
  laps: CapturedLapWithPackets[];
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
    frames = readKunosFrames(dumpPath);
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
 * Read all packets from an AC Evo recording. Exported for reuse by tests.
 *
 * v0.6 has car_model in GRAPHICS_EVO and track in STATIC_EVO, so we rely on the
 * parser cache to resolve names rather than reading them here directly.
 */
export function readAcEvoPackets(dumpPath: string): ParsedFrames {
  let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
  try {
    frames = readKunosFrames(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  const cache = createAcEvoParserCache();
  const packets: TelemetryPacket[] = [];
  for (const frame of frames) {
    const packet = parseAcEvoBuffers(frame.physics, frame.graphics, frame.staticData, cache);
    if (packet) packets.push(packet);
  }
  return {
    packets,
    carModel: cache.lastCarModel || null,
    trackName: cache.lastTrack || null,
  };
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

const DEFAULT_ACC_FRAME_STRIDE = 4;

export interface ParseDumpOptions {
  /** Capture broadcast packets and attach them to laps. Disable when a fixture only asserts lap metadata/events. */
  capturePackets?: boolean;
  /** Override default ACCTEST downsampling. Fixtures are recorded above pipeline broadcast rate. */
  accFrameStride?: number;
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
  dumpPath: string,
  options: ParseDumpOptions = {}
): Promise<DumpResult> {
  ensureInit();

  const db = new CapturingDbAdapter();
  const ws = new CapturingWsAdapter(options.capturePackets ?? true);
  const pipeline = new LiveTelemetryPipeline(db, ws, {
    bypassPacketRateFilter: true,
    recorder: new NullSessionRecorderAdapter(),
  });

  let carModel: string | null = null;
  let trackName: string | null = null;

  if (gameId === "acc") {
    let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
    try {
      frames = readKunosFrames(dumpPath);
    } catch {
      return { laps: [], sessions: [], carModel: null, trackName: null, wsNotifications: [], wsDevStates: [], rawPackets: [] };
    }

    if (frames.length > 0) {
      // ACCTEST recorder format. Parse and process each frame immediately so
      // full-session packet objects are not retained in a second array.
      let carOrdinal = 0;
      let trackOrdinal = 0;
      const frameStride = Math.max(1, Math.floor(options.accFrameStride ?? DEFAULT_ACC_FRAME_STRIDE));
      let frameIndex = 0;
      let processedFrames = 0;
      for (const frame of frames) {
        if (frameIndex++ % frameStride !== 0) continue;
        if (carOrdinal === 0 || trackOrdinal === 0) {
          const cm = readWString(frame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
          const tn = readWString(frame.staticData, STATIC.track.offset, STATIC.track.size);
          if (cm) {
            carModel = cm;
            carOrdinal = getAccCarByModel(cm)?.id ?? 0;
          }
          if (tn) {
            trackName = tn;
            trackOrdinal = getAccTrackByName(tn)?.id ?? 0;
          }
        }
        const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, { carOrdinal, trackOrdinal });
        if (packet) await pipeline.processPacket(packet);
        // Capture adapter writes resolve synchronously. Yield
        // periodically so long recordings do not defer GC until suite timeout.
        if ((++processedFrames & 1023) === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } else {
      let raw: Buffer;
      try {
        raw = readFileSync(dumpPath);
        if (dumpPath.endsWith(".gz")) raw = gunzipSync(raw);
      } catch {
        return { laps: [], sessions: [], carModel: null, trackName: null, wsNotifications: [], wsDevStates: [], rawPackets: [] };
      }
      if (raw.length < 4 || raw.readUInt32LE(0) !== META_FRAME_MAGIC) {
        return { laps: [], sessions: [], carModel: null, trackName: null, wsNotifications: [], wsDevStates: [], rawPackets: [] };
      }

      // Session bin format (packed triplets)
      const serverGame = getServerGame(gameId);
      const parserState = serverGame.createParserState?.() ?? null;
      let offset = 8 + raw.readUInt32LE(4); // skip meta frame
      while (offset < raw.length) {
        if (offset + 4 > raw.length) break;
        const frameLen = raw.readUInt32LE(offset);
        if (frameLen === META_FRAME_MAGIC) {
          offset += 8 + raw.readUInt32LE(offset + 4);
          continue;
        }
        offset += 4;
        if (offset + frameLen > raw.length) break;
        const packet = serverGame.tryParse(raw.subarray(offset, offset + frameLen), parserState);
        offset += frameLen;
        if (packet) await pipeline.processPacket(packet);
      }
    }
  } else if (gameId === "ac-evo") {
    const parsed = readAcEvoPackets(dumpPath);
    carModel = parsed.carModel;
    trackName = parsed.trackName;
    for (const packet of parsed.packets) {
      await pipeline.processPacket(packet);
    }
  } else if (gameId === "iracing") {
    const serverAdapter = getServerGame(gameId);
    const parserState = serverAdapter.createParserState?.() ?? null;
    let frames: Buffer[];
    try {
      frames = readIRacingFrames(dumpPath);
    } catch {
      frames = [];
    }
    for (const frame of frames) {
      const packet = serverAdapter.tryParse(frame, parserState);
      if (!packet) continue;
      carModel ??= packet.iracing?.carName ?? null;
      trackName ??= packet.iracing?.trackName ?? null;
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

  // Attach per-lap packets to each CapturedLap for test assertions
  const lapPacketsByNumber = new Map<number, TelemetryPacket[]>();
  for (const pkt of rawPackets) {
    const n = pkt.LapNumber;
    if (n !== undefined) {
      if (!lapPacketsByNumber.has(n)) lapPacketsByNumber.set(n, []);
      lapPacketsByNumber.get(n)!.push(pkt);
    }
  }
  for (const lap of db.laps) {
    lap.packets = lapPacketsByNumber.get(lap.lapNumber) ?? [];
  }

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

