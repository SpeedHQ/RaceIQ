import { zipSync } from "fflate";
import { gzipSync } from "node:zlib";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
} from "@raceiq/capture-formats/session/framing";
import { F1_HEADER_SIZE } from "@raceiq/capture-formats/f1-2025/f1-wire";

export interface CloudLapFixtureOptions {
  lapId?: string;
  lapGuid?:string;
  setup?: Buffer | null;
  recordedAt?: string | null;
  finishedAt?: string | null;
  frame?: Buffer;
  secondSegment?: boolean;
}

export function buildCloudLapImportFixture(options: CloudLapFixtureOptions = {}) {
  const lapId = options.lapId ?? `fixture-${crypto.randomUUID()}`;
  const frame = options.frame ?? (() => {
    const payload=Buffer.alloc(F1_HEADER_SIZE+22*60);
    payload.writeUInt16LE(2025,0);
    payload[2]=25;payload[3]=1;payload[5]=1;payload[6]=0;
    payload.writeBigUInt64LE(1n,7);
    payload.writeFloatLE(40,15);
    payload.writeUInt32LE(1,19);payload.writeUInt32LE(1,23);
    payload[27]=0;payload[28]=255;
    payload.writeFloatLE(25,F1_HEADER_SIZE+12);
    payload.writeInt16LE(32767,F1_HEADER_SIZE+24);
    payload.writeInt16LE(32767,F1_HEADER_SIZE+34);
    return payload;
  })();
  const sourceCapture = Buffer.concat([encodeFrameLength(frame.length), frame]);
  const capture = Buffer.concat([
    encodeMetaFrame(options.secondSegment ? 3 : 2),
    encodeSegmentContextFrame(),
    sourceCapture,
    encodeSegmentContextEndFrame(),
    ...(options.secondSegment?[sourceCapture,encodeSegmentBoundaryFrame(),sourceCapture]:[sourceCapture]),
  ]);
  const recording = gzipSync(capture);
  const setup = options.setup ?? null;
  const manifest = {
    schemaVersion:3,
    author: { userId: "fixture-author", displayName: "Fixture Driver" },
    lap: {
      id: lapId,
      guid:options.lapGuid??crypto.randomUUID(),
      gameId:"f1-2025",
      trackId: "1",
      carId:"41",
      totalTimeMs: 91_234,
      sectorTimesMs: [30_000, 30_500, 30_734],
      complete: true,
      valid: true,
      invalidReason: null,
      recordedAt: options.recordedAt === undefined ? "2026-09-01T12:00:00.000Z" : options.recordedAt,
      ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
      setAt: "2026-09-01T13:00:00.000Z",
      lapIndex: 2,
      sessionKey: 7,
      sessionUID:"1",
      sourceLapIndex: 5,
      sourceSessionKey: 9,
    },
    recording: { path: "recording.bin", format: "raceiq-session", frameVersion: "1", compression: "gzip", sizeBytes: recording.length },
    processing:{lapDetectorVersion:"fixture-detector",sourceFrameFormat:"f1-2025",sourceFrameVersion:null},
    setup: setup ? { path: "setup/opaque", fileName: "fixture.setup", sizeBytes: setup.length } : null,
  };
  const entries: Record<string, Uint8Array> = {
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "recording.bin": recording,
  };
  if (setup) entries["setup/opaque"] = setup;
  return { bytes: Buffer.from(zipSync(entries)), capture, recording, manifest, setup, frame };
}
