import type { GameId } from "../../../shared/games/ids";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { CapturedLap, CapturedSession, LiveTelemetryPublication, WsAdapter } from "../../../server/telemetry/pipeline-ports"
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../../server/telemetry/pipeline-ports"
import { LiveTelemetryPipeline } from "../../../server/telemetry/live-pipeline"
import type { LapSavedNotification } from "../../../server/lap-detection/types"
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { getAllServerGames, getServerGame } from "../../../server/games/registry";
import { readUdpDump } from "./udp";
import { readKunosFrames } from "../../../server/games/kunos/frame-reader";
import { readIRacingFrames } from "../../../server/games/iracing/recorder";
import { parseAccBuffers } from "../../../server/games/acc/parser";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../../../server/games/ac-evo/parser";
import { readWString } from "../../../server/games/acc/utils";
import { STATIC } from "../../../server/games/acc/structs";
import { getAccCarByModel } from "../../../shared/racing/cars/acc"
import { getAccTrackByName } from "../../../shared/racing/tracks/catalogs/acc"
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { META_FRAME_MAGIC } from "../../../server/session-capture/framing"

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

function assertLapsHavePackets(laps: CapturedLap[]): asserts laps is CapturedLapWithPackets[] {
  for (const lap of laps) {
    if (!Array.isArray(lap.packets)) {
      throw new Error(`Captured lap ${lap.lapNumber} is missing packet data`);
    }
  }
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

export interface TelemetryLapSegment {
  readonly start: number;
  readonly end: number;
  readonly minLapTime: number;
  readonly maxLapTime: number;
  readonly lapNumber: number | undefined;
}

export function segmentTelemetryLaps(
  packets: readonly TelemetryPacket[],
): TelemetryLapSegment[] {
  const segments: TelemetryLapSegment[] = [];
  let start = 0;
  let minLapTime = packets[0]?.CurrentLap ?? 0;
  let maxLapTime = minLapTime;

  const closeSegment = (end: number) => {
    if (end > start) {
      segments.push({
        start,
        end,
        minLapTime,
        maxLapTime,
        lapNumber: packets[start]?.LapNumber,
      });
    }
    start = end;
    minLapTime = packets[end]?.CurrentLap ?? 0;
    maxLapTime = minLapTime;
  };

  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1];
    const packet = packets[index];
    const sessionChanged =
      previous.sessionUID !== undefined &&
      packet.sessionUID !== undefined &&
      previous.sessionUID !== packet.sessionUID;
    const boundary =
      sessionChanged ||
      previous.LapNumber !== packet.LapNumber ||
      (previous.CurrentLap > 5 && packet.CurrentLap < 1) ||
      previous.DistanceTraveled - packet.DistanceTraveled > 500;
    if (boundary) closeSegment(index);
    minLapTime = Math.min(minLapTime, packet.CurrentLap);
    maxLapTime = Math.max(maxLapTime, packet.CurrentLap);
  }
  closeSegment(packets.length);
  return segments;
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
export function readUdpPackets(dumpPath: string, gameId?: GameId): ParsedFrames {
  ensureInit();
  let buffers: Buffer[];
  try {
    buffers = readUdpDump(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  if (buffers.length === 0) return { packets: [], carModel: null, trackName: null };
  const serverAdapter = gameId
    ? getServerGame(gameId)
    : getAllServerGames().find((a) => a.canHandle(buffers[0]));
  if (!serverAdapter) {
    return { packets: [], carModel: null, trackName: null };
  }
  const parserState = serverAdapter.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  for (const buf of buffers) {
    const packet = serverAdapter.tryParse(buf, parserState);
    if (packet) packets.push(packet);
  }
  return { packets, carModel: null, trackName: null };
}

const DEFAULT_ACC_FRAME_STRIDE = 4;

/**
 * Retains at most this many published packets for each contiguous lap/session
 * segment. The first and last packets are always retained; interior packets
 * are selected with a deterministic reservoir sample.
 */
export interface PacketSamplingOptions {
  readonly maxPacketsPerSegment: number;
  /** Runs for every published packet before retention sampling. */
  readonly validatePacket?: (packet: TelemetryPacket) => void;
}

export interface ParseDumpOptions {
  /** Capture broadcast packets and attach them to laps. Disable when a fixture only asserts lap metadata/events. */
  capturePackets?: boolean;
  /**
   * Bound retained broadcast history while every frame still traverses the
   * production parser and {@link LiveTelemetryPipeline}. Sampling preserves
   * each segment's boundaries and timing endpoints.
   */
  packetSampling?: PacketSamplingOptions;
  /** Override default ACCTEST downsampling. Fixtures are recorded above pipeline broadcast rate. */
  accFrameStride?: number;
}

interface CapturedPublication {
  readonly packet: TelemetryPacket;
  readonly sectors?: LiveTelemetryPublication["sectors"];
  readonly pit?: LiveTelemetryPublication["pit"];
  readonly liveIssues?: LiveTelemetryPublication["liveIssues"];
}

function isTelemetrySegmentBoundary(previous: TelemetryPacket, packet: TelemetryPacket): boolean {
  return (
    (previous.sessionUID !== undefined &&
      packet.sessionUID !== undefined &&
      previous.sessionUID !== packet.sessionUID) ||
    previous.LapNumber !== packet.LapNumber ||
    (previous.CurrentLap > 5 && packet.CurrentLap < 1) ||
    previous.DistanceTraveled - packet.DistanceTraveled > 500
  );
}

/**
 * Test-only packet capture for long replays. It never opts into native dev
 * telemetry, so the pipeline does not structured-clone every source frame.
 */
class SampledCapturingWsAdapter implements WsAdapter {
  readonly broadcastedPackets: CapturedPublication[] = [];
  readonly broadcastedNotifications: Record<string, unknown>[] = [];
  readonly broadcastedDevStates: Record<string, unknown>[] = [];
  readonly wantsDevTelemetry = false;
  private readonly maxPacketsPerSegment: number;
  private readonly validatePacket: ((packet: TelemetryPacket) => void) | undefined;
  private segment: {
    first: CapturedPublication;
    last: CapturedPublication;
    previous: TelemetryPacket;
    packetCount: number;
    interiorCount: number;
    randomState: number;
    interior: Array<{ publication: CapturedPublication; packetIndex: number }>;
  } | undefined;

  constructor(options: PacketSamplingOptions) {
    if (!Number.isSafeInteger(options.maxPacketsPerSegment) || options.maxPacketsPerSegment < 4) {
      throw new RangeError("packetSampling.maxPacketsPerSegment must be an integer of at least 4");
    }
    this.maxPacketsPerSegment = options.maxPacketsPerSegment;
    this.validatePacket = options.validatePacket;
  }

  broadcast(packet: TelemetryPacket, sectors?: LiveTelemetryPublication["sectors"], pit?: LiveTelemetryPublication["pit"], liveIssues?: LiveTelemetryPublication["liveIssues"]): void {
    this.validatePacket?.(packet);
    const publication = { packet, sectors, pit, liveIssues };
    if (this.segment && isTelemetrySegmentBoundary(this.segment.previous, packet)) {
      this.flushSegment();
    }
    if (!this.segment) {
      this.segment = {
        first: publication,
        last: publication,
        previous: packet,
        packetCount: 1,
        interiorCount: 0,
        randomState: 0x6d2b79f5,
        interior: [],
      };
      return;
    }

    const segment = this.segment;
    const priorLast = segment.last;
    segment.last = publication;
    segment.previous = packet;
    segment.packetCount += 1;
    if (segment.packetCount <= 2) return;

    segment.interiorCount += 1;
    const capacity = this.maxPacketsPerSegment - 2;
    if (segment.interior.length < capacity) {
      segment.interior.push({ publication: priorLast, packetIndex: segment.packetCount - 2 });
      return;
    }

    segment.randomState = (Math.imul(segment.randomState, 1664525) + 1013904223) >>> 0;
    const replacementIndex = segment.randomState % segment.interiorCount;
    if (replacementIndex < capacity) {
      segment.interior[replacementIndex] = { publication: priorLast, packetIndex: segment.packetCount - 2 };
    }
  }

  stageDevTelemetry(_packet: TelemetryPacket): void {}

  publishTelemetry(publication: LiveTelemetryPublication): void {
    this.broadcast(publication.packet, publication.sectors, publication.pit, publication.liveIssues);
  }

  broadcastNotification(event: Record<string, unknown>): void {
    this.broadcastedNotifications.push(event);
  }

  broadcastDevState(_state: Record<string, unknown>): void {}

  finalizePacketCapture(): void {
    this.flushSegment();
  }

  private flushSegment(): void {
    const segment = this.segment;
    if (!segment) return;
    this.broadcastedPackets.push(segment.first);
    if (segment.packetCount > 1) {
      segment.interior
        .sort((left, right) => left.packetIndex - right.packetIndex)
        .forEach(({ publication }) => this.broadcastedPackets.push(publication));
      this.broadcastedPackets.push(segment.last);
    }
    this.segment = undefined;
  }
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

  if (options.packetSampling && options.capturePackets === false) {
    throw new RangeError("packetSampling cannot be used when capturePackets is false");
  }

  const db = new CapturingDbAdapter();
  const ws = options.packetSampling
    ? new SampledCapturingWsAdapter(options.packetSampling)
    : new CapturingWsAdapter(options.capturePackets ?? true);
  const pipeline = new LiveTelemetryPipeline(db, ws, {
    bypassPacketRateFilter: true,
    skipDevState: options.packetSampling !== undefined,
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
  } else if (options.packetSampling) {
    let frames: Buffer[];
    try {
      frames = readUdpDump(dumpPath);
    } catch {
      frames = [];
    }
    if (frames.length === 0) {
      return { laps: [], sessions: [], carModel: null, trackName: null, wsNotifications: [], wsDevStates: [], rawPackets: [] };
    }

    const serverAdapter = getServerGame(gameId);
    const parserState = serverAdapter.createParserState?.() ?? null;
    let processedFrames = 0;
    for (const frame of frames) {
      const packet = serverAdapter.tryParse(frame, parserState);
      if (packet) await pipeline.processPacket(packet);
      if ((++processedFrames & 1023) === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } else {
    const parsed = readUdpPackets(dumpPath, gameId);
    if (parsed.packets.length === 0) return { laps: [], sessions: [], carModel: null, trackName: null, wsNotifications: [], wsDevStates: [], rawPackets: [] };
    for (const packet of parsed.packets) {
      await pipeline.processPacket(packet);
    }
  }

  // End of recording — flush any in-progress lap as incomplete (v2 only; v1 no-op)
  await pipeline.flushIncompleteLap();

  // Flush deferred insertLap calls (lap-detector uses setTimeout(..., 0))
  await new Promise<void>((r) => setTimeout(r, 0));

  // Finalize the trailing sampled segment before extracting packet history.
  if (ws instanceof SampledCapturingWsAdapter) ws.finalizePacketCapture();

  // Extract retained packets from broadcast events. By default this is every
  // packet; packetSampling keeps deterministic boundary-preserving samples.
  const rawPackets = ws.broadcastedPackets.map((e) => e.packet);

  // Match each captured DB lap to one contiguous packet segment. Lap numbers
  // restart across sessions, so grouping every packet by LapNumber mixes laps.
  const lapSegments = segmentTelemetryLaps(rawPackets);
  const unusedSegments = new Set(lapSegments.map((_, index) => index));
  for (const lap of db.laps) {
    let bestIndex: number | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const index of unusedSegments) {
      const segment = lapSegments[index];
      const packetCount = segment.end - segment.start;
      const lapNumberPenalty = segment.lapNumber === lap.lapNumber ? 0 : 10_000;
      const lapTimeDelta = Math.abs(segment.maxLapTime - lap.lapTime);
      const frameCountDelta = Math.abs(packetCount - lap.rawFrameCount);
      const score = lapNumberPenalty + lapTimeDelta + frameCountDelta / 1_000_000;
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex === undefined) {
      lap.packets = [];
      continue;
    }
    const segment = lapSegments[bestIndex];
    if (Math.abs(segment.maxLapTime - lap.lapTime) > 2) {
      lap.packets = [];
      continue;
    }
    unusedSegments.delete(bestIndex);
    const packetStart =
      lap.rawFrameCount > 0 ? Math.max(segment.start, segment.end - lap.rawFrameCount) : segment.start;
    lap.packets = rawPackets.slice(packetStart, segment.end);
  }
  assertLapsHavePackets(db.laps);

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

