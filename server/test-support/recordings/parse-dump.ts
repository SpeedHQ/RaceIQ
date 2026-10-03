import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { ServerGameAdapter } from "../../games/types";
import type { CapturedLap, CapturedSession } from "../../telemetry/pipeline-ports";
import type { LapSavedNotification } from "../../lap-detection/types";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../telemetry/pipeline-ports";
import { LiveTelemetryPipeline } from "../../telemetry/live-pipeline";
import { registerServerGame } from "../../games/registry";
import { registerGame } from "@raceiq/shared/games/registry";
import { readUdpDump } from "./udp";
import { isPitCycleLap } from "@raceiq/shared/racing/laps/pit-cycle";

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

export function readUdpPackets(dumpPath: string, adapter: ServerGameAdapter): ParsedFrames {
  let buffers: Buffer[];
  try {
    buffers = readUdpDump(dumpPath);
  } catch {
    return { packets: [], carModel: null, trackName: null };
  }
  if (buffers.length === 0) return { packets: [], carModel: null, trackName: null };
  const parserState = adapter.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];
  for (const buf of buffers) {
    const packet = adapter.tryParse(buf, parserState);
    if (packet) packets.push(packet);
  }
  return { packets, carModel: null, trackName: null };
}

export interface ParseDumpOptions {
  /** Capture broadcast packets and attach them to laps. Disable when a fixture only asserts lap metadata/events. */
  capturePackets?: boolean;
  /** Override default ACCTEST downsampling. Fixtures are recorded above pipeline broadcast rate. */
  accFrameStride?: number;
}

export interface RecordingGameSupport {
  adapter: ServerGameAdapter;
  readPackets(path: string, options: ParseDumpOptions): AsyncIterable<{
    packet: TelemetryPacket;
    carModel?: string | null;
    trackName?: string | null;
  }>;
}

export async function parseDump(
  game: RecordingGameSupport,
  dumpPath: string,
  options: ParseDumpOptions = {},
): Promise<DumpResult> {
  registerServerGame(game.adapter);
  registerGame(game.adapter);

  const db = new CapturingDbAdapter();
  const ws = new CapturingWsAdapter(options.capturePackets ?? true);
  const pipeline = new LiveTelemetryPipeline(db, ws, {
    bypassPacketRateFilter: true,
    recorder: new NullSessionRecorderAdapter(),
  });

  let carModel: string | null = null;
  let trackName: string | null = null;

  for await (const frame of game.readPackets(dumpPath, options)) {
    if (frame.carModel !== undefined) carModel = frame.carModel;
    if (frame.trackName !== undefined) trackName = frame.trackName;
    await pipeline.processPacket(frame.packet);
  }

  // End of recording — flush any in-progress lap as incomplete (v2 only; v1 no-op)
  await pipeline.flushIncompleteLap();

  // Flush deferred insertLap calls (lap-detector uses setTimeout(..., 0))
  await new Promise<void>((r) => setTimeout(r, 0));

  // Extract raw packets from broadcast events (all packets that went through the pipeline)
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
    const hasKnownTelemetryGap =
      lap.invalidReason === "telemetry lap time mismatch" || isPitCycleLap(lap);
    if (!hasKnownTelemetryGap && Math.abs(segment.maxLapTime - lap.lapTime) > 2) {
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
