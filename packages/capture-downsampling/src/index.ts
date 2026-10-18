import type { GameId } from "@raceiq/shared/games/ids";
import { F1_PACKET_IDS, parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { canHandleLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC } from "@raceiq/capture-formats/kunos/pack-triplet";
import { kunosSourceMagic } from "@raceiq/capture-formats/session/kunos-sparse";
import { genericFrameIdentity } from "@raceiq/capture-formats/session/generic-sparse";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame, IRacingSourceFrameEncoder, type IRacingSourceFrame } from "@raceiq/capture-formats/iracing/source-frame";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import type { RecordingFrequencyHz } from "@raceiq/shared/platform/runtime/recording-frequency";
import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import { SparseCaptureEncoder } from "@raceiq/capture-formats/session/sparse-recorder";

export type DownsampleLapIndex = { lapId: number; rawByteOffset: number | null; rawFrameCount: number | null };
export type DownsampleRecordingInput = {
  gameId: GameId;
  records: () => AsyncIterable<SessionCaptureRecord>;
  createTelemetryParser: () => { parse: (frame: Buffer) => boolean; reset: () => void };
  lapIndexes: readonly DownsampleLapIndex[];
  appendsDelayedFinishFrame?: boolean;
};
export type DownsampleRecordingErrorReason = "unsupported-format" | "unreliable-time";
export class DownsampleRecordingError extends Error {
  readonly reason: DownsampleRecordingErrorReason;
  constructor(reason: DownsampleRecordingErrorReason, message: string) {
    super(message);
    this.name = "DownsampleRecordingError";
    this.reason = reason;
  }
}
type TelemetryPoint = { ordinal: number; timeMs: number };
export type DownsampleLapWindow = {
  lapId: number;
  startOrdinal: number;
  endOrdinal: number;
  expectedRawByteOffset: number;
  expectedRawFrameCount: number;
  firstFrameOrdinal: number;
  lastFrameOrdinal: number;
  firstTelemetry: TelemetryPoint;
  lastTelemetry: TelemetryPoint;
  f1EndpointTelemetry: readonly { first: TelemetryPoint; last: TelemetryPoint }[];
};
export type DownsampleStreamPlan = { segment: number; stream: string; clock: "recorder" | "fm-timestamp" | "f1-session-time"; firstTelemetry: TelemetryPoint; lastTelemetry: TelemetryPoint; sampleRateHz: number | null };
export type DownsampleRecordingInspection = {
  gameId: GameId;
  frameCount: number;
  segmentCount: number;
  contextRanges: readonly { startOrdinal: number; endOrdinal: number }[];
  markers: readonly { kind: "segment-boundary" | "segment-context" | "segment-context-end"; ordinal: number }[];
  streams: readonly DownsampleStreamPlan[];
  laps: readonly DownsampleLapWindow[];
  f1TelemetryCounts: Readonly<Record<number, number>>;
};
const RATE_SAMPLE_FRAME_LIMIT = 1000;
const F1_THROTTLED: Record<number, true> = { [F1_PACKET_IDS.MOTION]: true, [F1_PACKET_IDS.CAR_TELEMETRY]: true, [F1_PACKET_IDS.MOTION_EX]: true };
type StreamState = {
  segment: number;
  stream: string;
  allRecorder: boolean;
  fallbackValid: boolean;
  first: TelemetryPoint | null;
  last: TelemetryPoint | null;
  recorderFirst: TelemetryPoint | null;
  recorderLast: TelemetryPoint | null;
  rateSampleCount: number;
  rateFirst: TelemetryPoint | null;
  rateLast: TelemetryPoint | null;
  rateRecorderFirst: TelemetryPoint | null;
  rateRecorderLast: TelemetryPoint | null;
  previousTime: number | null;
  fmWrap: number;
};
type LapState = { start: number; end: number; first: TelemetryPoint | null; last: TelemetryPoint | null; f1EndpointTelemetry: Map<string, { first: TelemetryPoint; last: TelemetryPoint }> };

/** Strictly inspects streamed canonical records; retained planning data is O(laps + streams). */
export async function inspectDownsampleRecording(input: DownsampleRecordingInput): Promise<DownsampleRecordingInspection> {
  const parser = input.createTelemetryParser(),
    starts = new Map<number, DownsampleLapIndex[]>(),
    lapIds = new Set<number>();
  for (const index of input.lapIndexes) {
    if (
      !Number.isSafeInteger(index.lapId) ||
      index.lapId <= 0 ||
      lapIds.has(index.lapId) ||
      (index.rawByteOffset !== null && (!Number.isSafeInteger(index.rawByteOffset) || index.rawByteOffset < 0)) ||
      (index.rawByteOffset !== null && (!Number.isSafeInteger(index.rawFrameCount) || index.rawFrameCount! <= 0))
    )
      throw new DownsampleRecordingError("unsupported-format", `Invalid lap index ${index.lapId}`);
    lapIds.add(index.lapId);
    if (index.rawByteOffset !== null) {
      const list = starts.get(index.rawByteOffset) ?? [];
      list.push(index);
      starts.set(index.rawByteOffset, list);
    }
  }
  const streams = new Map<string, StreamState>(),
    lapStates = new Map<number, LapState>(),
    active = new Set<LapState>(),
    pending = new Set<LapState>(),
    ends = new Map<number, LapState[]>();
  const contexts: { startOrdinal: number; endOrdinal: number }[] = [],
    markers: { kind: "segment-boundary" | "segment-context" | "segment-context-end"; ordinal: number }[] = [],
    f1TelemetryCounts: Record<number, number> = {};
  const latestF1Telemetry = new Map<string, TelemetryPoint>();
  let currentF1UID: bigint | null = null;
  let latest: TelemetryPoint | null = null,
    ordinal = 0,
    segment = 0,
    inContext = false,
    contextStart = 0,
    recordsSeen = 0,
    iracing = createIRacingSourceDecoderState(),
    telemetryFound = false;
  for await (const record of input.records()) {
    recordsSeen++;
    if (record.kind === "frame" && input.gameId === "f1-2025") {
      if (record.frame.length < 29) throw new DownsampleRecordingError("unsupported-format", "Truncated F1 packet");
      const h = parseF1Header(record.frame);
      if (h.packetFormat !== 2025) throw new DownsampleRecordingError("unsupported-format", "Invalid F1 packet header");
      if (currentF1UID !== h.sessionUID) {
        latestF1Telemetry.clear();
        currentF1UID = h.sessionUID;
      }
    }
    if (record.kind === "parser-bootstrap") {
      throw new DownsampleRecordingError("unsupported-format", "Checkpoint-initialized recordings cannot be downsampled");
    }
    if (record.kind === "segment-boundary") {
      markers.push({ kind: record.kind, ordinal });
      if (inContext) {
        contexts.push({ startOrdinal: contextStart, endOrdinal: ordinal });
        inContext = false;
      }
      latestF1Telemetry.clear();
      currentF1UID = null;
      segment++;
      parser.reset();
      iracing = createIRacingSourceDecoderState();
      continue;
    }
    if (record.kind === "segment-context-end") {
      markers.push({ kind: record.kind, ordinal });
      if (inContext) {
        contexts.push({ startOrdinal: contextStart, endOrdinal: ordinal });
        inContext = false;
      }
      continue;
    }
    if (record.kind === "segment-context") {
      markers.push({ kind: record.kind, ordinal });
      if (!inContext) {
        contextStart = ordinal;
        inContext = true;
      }
      continue;
    }
    if (record.kind !== "frame") continue;
    const current = ordinal++;
    for (const lap of ends.get(current) ?? []) {
      if (latest && latest.ordinal >= lap.start) lap.last = latest;
      pending.delete(lap);
      active.delete(lap);
    }
    for (const index of starts.get(record.offset) ?? []) {
      const state: LapState = {
        start: current,
        end: current + index.rawFrameCount!,
        first: null,
        last: null,
        f1EndpointTelemetry: new Map(
          [...latestF1Telemetry].map(([family, point]) => [family, { first: point, last: point }]),
        ),
      };
      if (!Number.isSafeInteger(state.end)) throw new DownsampleRecordingError("unsupported-format", `Lap ${index.lapId} frame window is invalid`);
      lapStates.set(index.lapId, state);
      active.add(state);
      pending.add(state);
      const ending = ends.get(state.end) ?? [];
      ending.push(state);
      ends.set(state.end, ending);
    }
    let stream = "default",
      eligible = true,
      gameTime = Number.NaN;
    if (input.gameId === "iracing") {
      if (!decodeIRacingSourceFrame(record.frame, iracing)) throw new DownsampleRecordingError("unsupported-format", "Invalid iRacing source delta chain");
    } else if (input.gameId === "f1-2025") {
      if (record.frame.length < 29) throw new DownsampleRecordingError("unsupported-format", "Truncated F1 packet");
      const h = parseF1Header(record.frame);
      if (h.packetFormat !== 2025) throw new DownsampleRecordingError("unsupported-format", "Invalid F1 packet header");
      gameTime = h.sessionTime * 1000;
      eligible = F1_THROTTLED[h.packetId] === true;
      stream = eligible ? `f1:${h.sessionUID}:${h.packetId}` : `f1-ancillary:${h.sessionUID}`;
      if (eligible) f1TelemetryCounts[h.packetId] = (f1TelemetryCounts[h.packetId] ?? 0) + 1;
    } else if (input.gameId === "fm-2023") {
      if (!genericFrameIdentity(record.frame)?.startsWith("fm:")) throw new DownsampleRecordingError("unsupported-format", "Invalid FM packet framing");
      gameTime = record.frame.readUInt32LE(4);
      stream = "fm";
    } else if (input.gameId === "acc" || input.gameId === "ac-evo") {
      if (kunosSourceMagic(record.frame) !== (input.gameId === "acc" ? ACC_PACKED_MAGIC : ACEVO_PACKED_MAGIC)) throw new DownsampleRecordingError("unsupported-format", "Invalid Kunos packed frame");
    } else if (input.gameId === "lmu" && !canHandleLMUSourceFrame(record.frame)) throw new DownsampleRecordingError("unsupported-format", "Invalid LMU source frame");
    const replayable = parser.parse(record.frame);
    if (!replayable) continue;
    if (inContext) continue;
    if (!eligible) continue;
    if (input.gameId === "f1-2025") {
      const packetId = parseF1Header(record.frame).packetId;
      if (F1_THROTTLED[packetId]) {
        const endpoint = { ordinal: current, timeMs: gameTime };
        const familyKey = `${currentF1UID}:${packetId}`;
        latestF1Telemetry.set(familyKey, endpoint);
        for (const lap of active) {
          const family = lap.f1EndpointTelemetry.get(familyKey);
          if (family) family.last = endpoint;
          else lap.f1EndpointTelemetry.set(familyKey, { first: endpoint, last: endpoint });
        }
      }
    }
    telemetryFound = true;
    const key = `${segment}:${stream}`;
    let state = streams.get(key);
    if (!state) {
      state = { segment, stream, allRecorder: true, fallbackValid: true, first: null, last: null, recorderFirst: null, recorderLast: null, rateSampleCount: 0, rateFirst: null, rateLast: null, rateRecorderFirst: null, rateRecorderLast: null, previousTime: null, fmWrap: 0 };
      streams.set(key, state);
    }
    if (record.frameTimeMs === undefined || !Number.isFinite(record.frameTimeMs)) state.allRecorder = false;
    else {
      const p = { ordinal: current, timeMs: record.frameTimeMs };
      state.recorderFirst ??= p;
      state.recorderLast = p;
    }
    let time: number;
    if (input.gameId === "fm-2023") {
      if (!Number.isFinite(gameTime)) state.fallbackValid = false;
      if (Number.isFinite(gameTime) && state.previousTime !== null && gameTime < state.previousTime - state.fmWrap && state.previousTime - state.fmWrap - gameTime > 0x80000000)
        state.fmWrap += 0x100000000;
      time = gameTime + state.fmWrap;
    } else if (input.gameId === "f1-2025") {
      if (!Number.isFinite(gameTime) || gameTime < 0) state.fallbackValid = false;
      time = gameTime;
    } else {
      if (record.frameTimeMs === undefined || !Number.isFinite(record.frameTimeMs)) state.fallbackValid = false;
      time = record.frameTimeMs ?? 0;
    }
    if (Number.isFinite(time)) state.previousTime = time;
    const point = { ordinal: current, timeMs: time };
    state.first ??= point;
    state.last = point;
    if (state.rateSampleCount < RATE_SAMPLE_FRAME_LIMIT) {
      state.rateFirst ??= point;
      state.rateLast = point;
      if (record.frameTimeMs !== undefined && Number.isFinite(record.frameTimeMs)) {
        const recorderPoint = { ordinal: current, timeMs: record.frameTimeMs };
        state.rateRecorderFirst ??= recorderPoint;
        state.rateRecorderLast = recorderPoint;
      }
      state.rateSampleCount++;
    }
    latest = point;
    for (const lap of pending) lap.first = point;
    pending.clear();
  }
  for (const lap of active) if (latest && latest.ordinal >= lap.start && latest.ordinal < lap.end) lap.last = latest;
  if (inContext) contexts.push({ startOrdinal: contextStart, endOrdinal: ordinal });
  if (!recordsSeen || !ordinal) throw new DownsampleRecordingError("unsupported-format", "Empty recording");
  if (!telemetryFound) throw new DownsampleRecordingError("unsupported-format", "Recording has no replayable telemetry");
  const laps: DownsampleLapWindow[] = [];
  for (const index of input.lapIndexes) {
    if (index.rawByteOffset === null) continue;
    const state = lapStates.get(index.lapId);
    if (!state || state.end > ordinal || !state.first || !state.last)
      throw new DownsampleRecordingError("unsupported-format", `Lap ${index.lapId} index has invalid window or no replayable telemetry`);
    laps.push({
      lapId: index.lapId,
      startOrdinal: state.start,
      endOrdinal: state.end,
      expectedRawByteOffset: index.rawByteOffset,
      expectedRawFrameCount: index.rawFrameCount!,
      firstFrameOrdinal: state.start,
      lastFrameOrdinal: state.end - 1,
      firstTelemetry: state.first,
      lastTelemetry: state.last,
      f1EndpointTelemetry: [...state.f1EndpointTelemetry.values()],
    });
  }
  const streamPlans: DownsampleStreamPlan[] = [];
  for (const state of streams.values()) {
    if (!state.first || !state.last) continue;
    if (!state.allRecorder && !state.fallbackValid) throw new DownsampleRecordingError("unreliable-time", "Selected stream clock contains invalid timestamps");
    if (!state.allRecorder && input.gameId !== "fm-2023" && input.gameId !== "f1-2025") throw new DownsampleRecordingError("unreliable-time", "Native stream lacks complete recorder timestamps");
    const firstTelemetry = state.allRecorder ? state.recorderFirst! : state.first;
    const lastTelemetry = state.allRecorder ? state.recorderLast! : state.last;
    const rateFirst = state.allRecorder ? state.rateRecorderFirst! : state.rateFirst!;
    const rateLast = state.allRecorder ? state.rateRecorderLast! : state.rateLast!;
    const rateElapsedMs = rateLast.timeMs - rateFirst.timeMs;
    streamPlans.push({
      segment: state.segment,
      stream: state.stream,
      clock: state.allRecorder ? "recorder" : input.gameId === "fm-2023" ? "fm-timestamp" : "f1-session-time",
      firstTelemetry,
      lastTelemetry,
      sampleRateHz: state.rateSampleCount > 1 && rateElapsedMs > 0
        ? (state.rateSampleCount - 1) * 1000 / rateElapsedMs
        : null,
    });
  }
  return { gameId: input.gameId, frameCount: ordinal, segmentCount: segment + 1, contextRanges: contexts, markers, streams: streamPlans, laps, f1TelemetryCounts };
}

export type DownsampleRecordingRewrite = {
  outputPath: string;
  sourceFrameCount: number;
  frameCount: number;
  gzip: boolean;
  lapIndexes: {
    lapId: number;
    expectedRawByteOffset: number;
    expectedRawFrameCount: number;
    rawByteOffset: number;
    rawFrameCount: number;
  }[];
  validationDigest: string;
};
export type DownsampleRecordingRewriteOptions = { targetHz: RecordingFrequencyHz; outputPath: string; gzip: boolean };
function writeAll(fd: number, buf: Buffer, position?: number): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = position === undefined ? writeSync(fd, buf, offset, buf.length - offset) : writeSync(fd, buf, offset, buf.length - offset, position + offset);
    if (written === 0) throw new Error("Capture output write made no progress");
    offset += written;
  }
}

function admit(time: number, period: number, state: { deadline: number; previous: number; initialized: boolean }): boolean {
  if (!Number.isFinite(time)) return false;
  if (!state.initialized || time < state.previous) {
    state.deadline = time + period;
    state.previous = time;
    state.initialized = true;
    return true;
  }
  state.previous = time;
  if (time + 1e-7 < state.deadline) return false;
  const intervals = Math.max(1, Math.floor((time - state.deadline + 1e-7) / period) + 1);
  state.deadline += intervals * period;
  return true;
}

function updateSemanticDigest(hash: Hash, value: unknown): void {
  if (value === null) {
    hash.update("null;");
    return;
  }
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}[`);
    for (const item of value) updateSemanticDigest(hash, item);
    hash.update("];");
    return;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    hash.update(`object:${keys.length}{`);
    for (const key of keys) {
      hash.update(`${JSON.stringify(key)}:`);
      updateSemanticDigest(hash, object[key]);
    }
    hash.update("};");
    return;
  }
  hash.update(`${typeof value}:${String(value)};`);
}

function updateDigest(hash: Hash, record: SessionCaptureRecord, decoded?: IRacingSourceFrame): void {
  if (record.kind !== "frame") {
    hash.update(`marker:${record.kind}\0`);
    return;
  }
  hash.update(`time:${record.frameTimeMs === undefined ? "absent" : record.frameTimeMs}\0`);
  if (decoded) {
    updateSemanticDigest(hash, decoded);
  } else {
    hash.update(record.frame);
  }
}
/** Rewrites inspected records through bounded streaming state; temp suffixes are cleanup-contract names. */
export async function rewriteDownsampleRecording(
  input: DownsampleRecordingInput,
  inspection: DownsampleRecordingInspection,
  options: DownsampleRecordingRewriteOptions,
): Promise<DownsampleRecordingRewrite> {
  if (inspection.gameId !== input.gameId) {
    throw new DownsampleRecordingError("unsupported-format", "Inspection game does not match source");
  }

  const rawPath = options.gzip ? `${options.outputPath}.raw.tmp` : options.outputPath;
  const tempPath = `${options.outputPath}.tmp`;
  if (existsSync(options.outputPath) || existsSync(tempPath) || (options.gzip && existsSync(rawPath))) {
    throw new Error(`Downsample output already exists: ${options.outputPath}`);
  }

  let fd: number | null = null;
  let rawCreated = false;
  let tempCreated = false;
  let targetCreated = false;
  try {
    fd = openSync(rawPath, "wx");
    rawCreated = true;
    writeAll(fd, encodeMetaFrame(0));
    writeAll(fd, encodeSparseCaptureFormatFrame());

    let outputOffset = 28;
    let ordinal = 0;
    let segment = 0;
    let inContext = false;
    let sourceDecoder = createIRacingSourceDecoderState();
    const parser = input.createTelemetryParser();
    const outputEncoder = new IRacingSourceFrameEncoder();
    const sparseEncoder = new SparseCaptureEncoder(input.gameId);
    const clocks = new Map<
      string,
      {
        deadline: number;
        previous: number;
        initialized: boolean;
        fmWrap: number;
        previousRaw: number | null;
      }
    >();
    const streamPlans = new Map(inspection.streams.map((plan) => [`${plan.segment}:${plan.stream}`, plan]));
    const forcedOrdinals = new Set<number>();

    for (const marker of inspection.markers) forcedOrdinals.add(marker.ordinal);
    for (const stream of inspection.streams) {
      forcedOrdinals.add(stream.firstTelemetry.ordinal);
      forcedOrdinals.add(stream.lastTelemetry.ordinal);
    }
    for (const lap of inspection.laps) {
      forcedOrdinals.add(lap.firstFrameOrdinal);
      forcedOrdinals.add(lap.lastFrameOrdinal);
      forcedOrdinals.add(lap.firstTelemetry.ordinal);
      forcedOrdinals.add(lap.lastTelemetry.ordinal);
      for (const endpoints of lap.f1EndpointTelemetry) {
        forcedOrdinals.add(endpoints.first.ordinal);
        forcedOrdinals.add(endpoints.last.ordinal);
      }
      const finishOrdinal = lap.lastFrameOrdinal + 1;
      if (
        input.appendsDelayedFinishFrame &&
        finishOrdinal < inspection.frameCount &&
        !inspection.markers.some((marker) => marker.kind === "segment-boundary" && marker.ordinal === finishOrdinal)
      ) {
        forcedOrdinals.add(finishOrdinal);
      }
    }

    type LapProgress = {
      lap: DownsampleLapWindow;
      rawByteOffset: number;
      rawFrameStartCount: number;
      rawFrameCount: number;
    };
    const lapProgress: LapProgress[] = inspection.laps.map((lap) => ({
      lap,
      rawByteOffset: -1,
      rawFrameStartCount: 0,
      rawFrameCount: 0,
    }));
    const lapStarts = new Map<number, LapProgress[]>();
    const lapEnds = new Map<number, LapProgress[]>();
    for (const state of lapProgress) {
      const startsAtOrdinal = lapStarts.get(state.lap.startOrdinal) ?? [];
      startsAtOrdinal.push(state);
      lapStarts.set(state.lap.startOrdinal, startsAtOrdinal);
      const endsAtOrdinal = lapEnds.get(state.lap.endOrdinal) ?? [];
      endsAtOrdinal.push(state);
      lapEnds.set(state.lap.endOrdinal, endsAtOrdinal);
    }
    const hash = createHash("sha256");
    let outputFrameCount = 0;

    for await (const record of input.records()) {
      if (record.kind === "parser-bootstrap") {
        throw new DownsampleRecordingError("unsupported-format", "Checkpoint-initialized recordings cannot be downsampled");
      }
      if (record.kind === "segment-boundary") {
        updateDigest(hash, record);
        writeAll(fd, encodeSegmentBoundaryFrame());
        outputOffset += 16;
        segment++;
        parser.reset();
        sourceDecoder = createIRacingSourceDecoderState();
        outputEncoder.reset();
        sparseEncoder.reset();
        clocks.clear();
        inContext = false;
        continue;
      }
      if (record.kind === "segment-context") {
        updateDigest(hash, record);
        writeAll(fd, encodeSegmentContextFrame());
        outputOffset += 16;
        inContext = true;
        continue;
      }
      if (record.kind === "segment-context-end") {
        updateDigest(hash, record);
        writeAll(fd, encodeSegmentContextEndFrame());
        outputOffset += 16;
        inContext = false;
        outputEncoder.reset();
        sparseEncoder.reset();
        continue;
      }

      if (record.kind !== "frame") continue;
      const frameOrdinal = ordinal++;
      const decoded = input.gameId === "iracing" ? decodeIRacingSourceFrame(record.frame, sourceDecoder) : null;
      if (input.gameId === "iracing" && !decoded) {
        throw new DownsampleRecordingError("unsupported-format", "Invalid iRacing source delta chain");
      }
      const replayableTelemetry = parser.parse(record.frame);
      let streamName = "default";
      let eligibleStream = true;
      let gameTime = Number.NaN;
      if (input.gameId === "fm-2023") {
        streamName = "fm";
        gameTime = record.frame.readUInt32LE(4);
      } else if (input.gameId === "f1-2025") {
        const header = parseF1Header(record.frame);
        eligibleStream = F1_THROTTLED[header.packetId] === true;
        streamName = eligibleStream ? `f1:${header.sessionUID}:${header.packetId}` : `f1-ancillary:${header.sessionUID}`;
        gameTime = header.sessionTime * 1000;
      }

      const mustKeep = !replayableTelemetry || inContext || forcedOrdinals.has(frameOrdinal) || !eligibleStream;
      let shouldKeep = mustKeep;
      if (replayableTelemetry && !inContext && eligibleStream) {
        const key = `${segment}:${streamName}`;
        const plan = streamPlans.get(key);
        if (!plan) {
          throw new DownsampleRecordingError("unreliable-time", `Missing inspected clock: ${key}`);
        }
        const time = plan.clock === "recorder" ? (record.frameTimeMs ?? Number.NaN) : input.gameId === "fm-2023" ? gameTime : parseF1Header(record.frame).sessionTime * 1000;
        let clock = clocks.get(key);
        if (!clock) {
          clock = { deadline: 0, previous: 0, initialized: false, fmWrap: 0, previousRaw: null };
          clocks.set(key, clock);
        }
        let sampleTime = time;
        if (input.gameId === "fm-2023" && plan.clock === "fm-timestamp") {
          const rawTime = record.frame.readUInt32LE(4);
          if (clock.previousRaw !== null && rawTime < clock.previousRaw && clock.previousRaw - rawTime > 0x80000000) {
            clock.fmWrap += 0x100000000;
          }
          clock.previousRaw = rawTime;
          sampleTime += clock.fmWrap;
        }
        const admitted = admit(sampleTime, 1000 / options.targetHz, clock);
        shouldKeep = mustKeep || admitted;
      }
      if (!shouldKeep) continue;

      const offset = outputOffset;
      for (const state of lapStarts.get(frameOrdinal) ?? []) {
        state.rawByteOffset = offset;
        state.rawFrameStartCount = outputFrameCount;
      }
      const frame = decoded ? outputEncoder.encode(decoded) : record.frame;
      const sparseFrame = sparseEncoder.encode(frame, offset);
      const prefix = encodeFrameLength(sparseFrame.length, record.frameTimeMs);
      writeAll(fd, prefix);
      writeAll(fd, sparseFrame);
      outputOffset += prefix.length + sparseFrame.length;
      outputFrameCount++;
      updateDigest(hash, record, decoded ?? undefined);
      for (const state of lapEnds.get(frameOrdinal + 1) ?? []) {
        state.rawFrameCount = outputFrameCount - state.rawFrameStartCount;
      }
    }

    if (ordinal !== inspection.frameCount) {
      throw new DownsampleRecordingError("unsupported-format", "Source changed after inspection");
    }
    writeAll(fd, encodeMetaFrame(outputFrameCount), 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    if (options.gzip) {
      const compressedFd = openSync(tempPath, "wx");
      tempCreated = true;
      try {
        await pipeline(createReadStream(rawPath), createGzip(), createWriteStream(tempPath, { fd: compressedFd, autoClose: false }));
        fsyncSync(compressedFd);
      } finally {
        closeSync(compressedFd);
      }
      linkSync(tempPath, options.outputPath);
      targetCreated = true;
      unlinkSync(tempPath);
      tempCreated = false;
      unlinkSync(rawPath);
      rawCreated = false;
    } else {
      targetCreated = true;
    }

    const lapIndexes = lapProgress.map(({ lap, rawByteOffset, rawFrameCount }) => {
      if (rawByteOffset < 0 || rawFrameCount <= 0) {
        throw new DownsampleRecordingError("unsupported-format", `Lap ${lap.lapId} boundary not retained`);
      }
      return {
        lapId: lap.lapId,
        expectedRawByteOffset: lap.expectedRawByteOffset,
        expectedRawFrameCount: lap.expectedRawFrameCount,
        rawByteOffset,
        rawFrameCount,
      };
    });
    return {
      outputPath: options.outputPath,
      sourceFrameCount: inspection.frameCount,
      frameCount: outputFrameCount,
      gzip: options.gzip,
      lapIndexes,
      validationDigest: hash.digest("hex"),
    };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (rawCreated) {
      try {
        unlinkSync(rawPath);
      } catch {}
    }
    if (tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
    if (targetCreated) {
      try {
        unlinkSync(options.outputPath);
      } catch {}
    }
    throw error;
  }
}

async function validateOutputHeader(result: DownsampleRecordingRewrite): Promise<void> {
  const header = Buffer.alloc(12);
  if (!result.gzip) {
    const fd = openSync(result.outputPath, "r");
    try {
      if (readSync(fd, header, 0, header.length, 0) !== header.length) {
        throw new DownsampleRecordingError("unsupported-format", "Output header is truncated");
      }
    } finally {
      closeSync(fd);
    }
  } else {
    let received = 0;
    let stopping = false;
    let iterationFailure: unknown;
    let streamFailure: unknown;
    const source = createReadStream(result.outputPath);
    const gunzip = createGunzip();
    source.on("error", (error) => {
      if (!stopping) streamFailure = error;
    });
    gunzip.on("error", (error) => {
      if (!stopping) streamFailure = error;
    });
    const completion = pipeline(source, gunzip).catch((error: unknown) => {
      if (!stopping) streamFailure = error;
    });
    try {
      for await (const chunk of gunzip) {
        const take = Math.min(header.length - received, chunk.length);
        chunk.copy(header, received, 0, take);
        received += take;
        if (received === header.length) break;
      }
    } catch (error) {
      iterationFailure = error;
    } finally {
      stopping = true;
      source.destroy();
      gunzip.destroy();
    }
    await completion;
    if (streamFailure) throw streamFailure;
    if (iterationFailure) throw iterationFailure;
    if (received !== header.length) {
      throw new DownsampleRecordingError("unsupported-format", "Gzipped output header is truncated");
    }
  }
  if (header.readUInt32LE(0) !== 0xffffffff || header.readUInt32LE(4) !== 4 || header.readUInt32LE(8) !== result.frameCount) {
    throw new DownsampleRecordingError("unsupported-format", "Output header frame count is invalid");
  }
}

export async function validateDownsampleRecording(output: DownsampleRecordingInput, result: DownsampleRecordingRewrite): Promise<void> {
  await validateOutputHeader(result);
  const checked = await inspectDownsampleRecording(output);
  if (checked.frameCount !== result.frameCount) {
    throw new DownsampleRecordingError("unsupported-format", "Output frame count mismatch");
  }
  const hash = createHash("sha256");
  let decoder = createIRacingSourceDecoderState();
  for await (const record of output.records()) {
    if (record.kind === "segment-boundary") {
      updateDigest(hash, record);
      decoder = createIRacingSourceDecoderState();
      continue;
    }
    if (record.kind !== "frame") {
      updateDigest(hash, record);
      continue;
    }
    let decoded: IRacingSourceFrame | undefined;
    if (output.gameId === "iracing") {
      const frame = decodeIRacingSourceFrame(record.frame, decoder);
      if (!frame) {
        throw new DownsampleRecordingError("unsupported-format", "Output iRacing delta chain is invalid");
      }
      decoded = frame;
    }
    updateDigest(hash, record, decoded);
  }
  if (hash.digest("hex") !== result.validationDigest) {
    throw new DownsampleRecordingError("unsupported-format", "Output semantic digest does not match selected source frames");
  }
  for (const index of result.lapIndexes) {
    const lap = checked.laps.find((candidate) => candidate.lapId === index.lapId);
    if (!lap || lap.expectedRawByteOffset !== index.rawByteOffset || lap.expectedRawFrameCount !== index.rawFrameCount) {
      throw new DownsampleRecordingError("unsupported-format", `Remapped lap ${index.lapId} failed validation`);
    }
  }
}
