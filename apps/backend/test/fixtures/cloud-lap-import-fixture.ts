import { zipSync } from "fflate";
import { gzipSync } from "node:zlib";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
} from "@raceiq/capture-formats/session/framing";

export interface CloudLapFixtureOptions {
  lapId?: string;
  setup?: Buffer | null;
  recordedAt?: string | null;
  frame?: Buffer;
  secondSegment?: boolean;
}

export function buildCloudLapImportFixture(options: CloudLapFixtureOptions = {}) {
  const lapId = options.lapId ?? `fixture-${crypto.randomUUID()}`;
  const frame = options.frame ?? (() => {
    const payload = Buffer.alloc(331);
    payload.writeInt32LE(1, 0); // IsRaceOn
    payload.writeUInt32LE(1_000, 4); // Timestamp
    payload.writeFloatLE(8_000, 8); // Max RPM
    payload.writeFloatLE(4_000, 16); // RPM
    payload.writeInt32LE(1, 212); // Car ID
    payload.writeFloatLE(25, 244); // Speed
    payload.writeFloatLE(40, 292); // Current lap
    payload.writeUInt16LE(2, 300); // Lap number
    payload.writeUInt8(3, 307); // Gear
    payload.writeInt32LE(1, 327); // Track ID
    return payload;
  })();
  const sourceCapture = Buffer.concat([encodeFrameLength(frame.length), frame]);
  const capture = Buffer.concat([
    encodeMetaFrame(options.secondSegment ? 3 : 2),
    encodeSegmentContextFrame(),
    sourceCapture,
    encodeSegmentContextEndFrame(),
    ...(options.secondSegment ? [encodeSegmentBoundaryFrame(), sourceCapture] : [sourceCapture]),
  ]);
  const recording = gzipSync(capture);
  const setup = options.setup ?? null;
  const manifest = {
    schemaVersion: 2,
    author: { userId: "fixture-author", displayName: "Fixture Driver" },
    lap: {
      id: lapId,
      gameId: "fm-2023",
      trackId: "1",
      carId: "1",
      totalTimeMs: 91_234,
      sectorTimesMs: [30_000, 30_500, 30_734],
      complete: true,
      valid: true,
      invalidReason: null,
      recordedAt: options.recordedAt === undefined ? "2026-09-01T12:00:00.000Z" : options.recordedAt,
      setAt: "2026-09-01T13:00:00.000Z",
      lapIndex: 2,
      sessionKey: 7,
      sessionUID: "fixture-session",
      sourceLapIndex: 5,
      sourceSessionKey: 9,
    },
    recording: { path: "recording.bin", format: "raceiq-session", frameVersion: "1", compression: "gzip", sizeBytes: recording.length },
    processing: { lapDetectorVersion: "fixture-detector", sourceFrameFormat: "fm-2023", sourceFrameVersion: null },
    setup: setup ? { path: "setup/opaque", fileName: "fixture.setup", sizeBytes: setup.length } : null,
  };
  const entries: Record<string, Uint8Array> = {
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "recording.bin": recording,
  };
  if (setup) entries["setup/opaque"] = setup;
  return { bytes: Buffer.from(zipSync(entries)), capture, recording, manifest, setup, frame };
}
