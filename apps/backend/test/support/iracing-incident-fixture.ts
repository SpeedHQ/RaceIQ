import { gzipSync } from "node:zlib";
import { IRacingSourceFrameEncoder, type IRacingSourceFrameV3 } from "@raceiq/capture-formats/iracing/source-frame";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
  encodeSparseCaptureFormatFrame,
} from "@raceiq/capture-formats/session/framing";

export interface IRacingIncidentFixtureIdentity {
  sessionId: number;
  subSessionId: number;
  sessionNum: number;
  driverCarIdx: number;
  trackId: number;
  trackName: string;
  carId: number;
  carName: string;
}

export interface IRacingIncidentFixtureSample {
  lapId?: number;
  /** False records shared capture data without creating a requested lap window. */
  owned?: boolean;
  /** Per-sample native segment identity; omitted fields inherit fixture identity. */
  identity?: Partial<IRacingIncidentFixtureIdentity>;
  /** Recorder timestamp prefix, in milliseconds. */
  frameTimeMs?: number;
  values: Record<string, number | boolean | string | Array<number | boolean>>;
  /** Mark source frame as segment context: it primes encoding but is not owned evidence. */
  context?: boolean;
}

export type IRacingIncidentFixtureRecord =
  | { kind: "sample"; sample: IRacingIncidentFixtureSample }
  | { kind: "segment-boundary" }
  | { kind: "segment-context" }
  | { kind: "segment-context-end" }
  | { kind: "malformed"; bytes?: Buffer };

export interface IRacingIncidentFixtureLapWindow {
  lapId: number;
  rawByteOffset: number;
  rawFrameCount: number;
  sampleIndexes: number[];
}

export interface IRacingIncidentFixture {
  /** Stored bytes (gzip encoded when requested); offsets always address decompressed bytes. */
  bytes: Buffer;
  decompressedBytes: Buffer;
  identity: IRacingIncidentFixtureIdentity;
  windows: IRacingIncidentFixtureLapWindow[];
  samples: Array<{ index: number; lapId: number | null; rawOffset: number; values: Readonly<Record<string, unknown>>; context: boolean }>;
}

const DEFAULT_IDENTITY: IRacingIncidentFixtureIdentity = {
  sessionId: 202,
  subSessionId: 205,
  sessionNum: 1,
  driverCarIdx: 0,
  trackId: 99,
  trackName: "Incident Fixture Track",
  carId: 42,
  carName: "Incident Fixture Car",
};

function nativeFrame(
  identity: IRacingIncidentFixtureIdentity,
  sessionTick: number,
  values: IRacingIncidentFixtureSample["values"],
): IRacingSourceFrameV3 {
  return {
    schemaVersion: 3,
    session: {
      sessionId: identity.sessionId,
      subSessionId: identity.subSessionId,
      sessionNum: identity.sessionNum,
      driverCarIdx: identity.driverCarIdx,
      trackId: identity.trackId,
      trackName: identity.trackName,
      trackLengthM: 5000,
      sectorStarts: [0, 0.5],
      carId: identity.carId,
      carName: identity.carName,
      carClassId: 8,
      carClassName: "GT3",
      engineIdleRpm: 900,
      engineRedlineRpm: 8500,
      engineCylinderCount: 8,
    },
    values: { SessionTick: sessionTick, SessionTime: sessionTick / 20, SessionNum: identity.sessionNum, ...values },
    sessionInfo: "WeekendInfo:\n  TrackName: Incident Fixture Track\n",
    sessionInfoUpdate: 1,
  };
}

/**
 * Build deterministic native iRacing capture bytes. Frame offsets are logical
 * decompressed offsets, matching session lap-window columns for both plain and gzip.
 */
export function createIRacingIncidentFixture(options: {
  records: readonly IRacingIncidentFixtureRecord[];
  identity?: Partial<IRacingIncidentFixtureIdentity>;
  gzip?: boolean;
  metadataFrames?: number;
  sparseFormatMarker?: boolean;
}): IRacingIncidentFixture {
  const identity = { ...DEFAULT_IDENTITY, ...options.identity };
  const encoder = new IRacingSourceFrameEncoder();
  const chunks: Buffer[] = [encodeMetaFrame(options.metadataFrames ?? 0)];
  if (options.sparseFormatMarker ?? true) chunks.push(encodeSparseCaptureFormatFrame());
  const windows = new Map<number, IRacingIncidentFixtureLapWindow>();
  const samples: IRacingIncidentFixture["samples"] = [];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  let sessionTick = 0;
  let sampleIndex = 0;
  for (const record of options.records) {

    if (record.kind === "segment-boundary") {
      encoder.reset();
      chunks.push(encodeSegmentBoundaryFrame());
      offset += chunks[chunks.length - 1]!.length;
      continue;
    }
    if (record.kind === "segment-context") {
      chunks.push(encodeSegmentContextFrame());
      offset += chunks[chunks.length - 1]!.length;
      continue;
    }
    if (record.kind === "segment-context-end") {
      chunks.push(encodeSegmentContextEndFrame());
      offset += chunks[chunks.length - 1]!.length;
      continue;
    }
    if (record.kind === "malformed") {
      const bytes = record.bytes ?? Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]);
      chunks.push(bytes);
      offset += bytes.length;
      continue;
    }

    const sample = record.sample;
    const sampleIdentity = { ...identity, ...sample.identity };
    if (sample.context) {
      chunks.push(encodeSegmentContextFrame());
      offset += chunks[chunks.length - 1]!.length;
    }
    const frameValues = { ...sample.values };
    const frameBytes = encoder.encode(nativeFrame(sampleIdentity, sessionTick++, frameValues));
    const frameOffset = offset;
    const framed = Buffer.concat([encodeFrameLength(frameBytes.length, sample.frameTimeMs), frameBytes]);
    chunks.push(framed);
    offset += framed.length;
    if (sample.context) {
      chunks.push(encodeSegmentContextEndFrame());
      offset += chunks[chunks.length - 1]!.length;
    }
    samples.push({ index: sampleIndex++, lapId: sample.lapId ?? null, rawOffset: frameOffset, values: frameValues, context: sample.context ?? false });
    if (sample.lapId !== undefined && sample.owned !== false && !sample.context) {
      let window = windows.get(sample.lapId);
      if (!window) {
        window = { lapId: sample.lapId, rawByteOffset: frameOffset, rawFrameCount: 0, sampleIndexes: [] };
        windows.set(sample.lapId, window);
      } else if (window.sampleIndexes[window.sampleIndexes.length - 1] !== sampleIndex - 2) {
        throw new Error(`Lap ${sample.lapId} has disjoint sample windows; use distinct lap IDs or explicit windows`);
      }
      window.rawFrameCount += 1;
      window.sampleIndexes.push(sampleIndex - 1);
    }
  }

  const decompressedBytes = Buffer.concat(chunks);
  return {
    bytes: options.gzip ? gzipSync(decompressedBytes) : decompressedBytes,
    decompressedBytes,
    identity,
    windows: [...windows.values()],
    samples,
  };
}

/** Main-plan two-lap fixture, with caller-supplied foreign records left unowned. */
export function createIRacingIncidentMainFixture(options: { gzip?: boolean } = {}): IRacingIncidentFixture {
  const records: IRacingIncidentFixtureRecord[] = [];
  const laps = [
    { lapId: 1, counters: [0, 0, 1, 1, 1, 1, 1, 1], surfaces: [3, 3, 0, 0, 3, 3, 3, 3] },
    { lapId: 2, counters: [1, 1, 3, 3, 3, 3, 3, 3], surfaces: [3, 3, 3, 0, 0, 3, 3, 3] },
  ];
  let time = 60;
  for (const lap of laps) {
    for (let index = 0; index < lap.counters.length; index += 1) {
      records.push({ kind: "sample", sample: {
        lapId: lap.lapId,
        values: {
          SessionTime: time,
          SessionTick: Math.round(time * 60),
          Lap: lap.lapId,
          LapCurrentLapTime: index * 0.05,
          LapLastLapTime: 0,
          IsOnTrack: true,
          PlayerCarMyIncidentCount: lap.counters[index]!,
          PlayerCarIdx: 0,
          PlayerTrackSurface: lap.surfaces[index]!,
          Speed: 20 + index,
        },
      } });
      time += 0.05;
    }
  }
  
  for (let index = 0; index < 8; index += 1) {
    records.push({ kind: "sample", sample: {
      lapId: 3,
      owned: false,
      values: {
        SessionTime: time,
        SessionTick: Math.round(time * 60),
        Lap: 3,
        LapCurrentLapTime: index * 0.05,
        LapLastLapTime: 0,
        IsOnTrack: true,
        PlayerCarMyIncidentCount: 50,
        PlayerCarIdx: 1,
        PlayerTrackSurface: index === 3 || index === 4 ? 0 : 3,
        Speed: 30 + index,
      },
    } });
    time += 0.05;
  }
  return createIRacingIncidentFixture({ records, gzip: options.gzip });
}
