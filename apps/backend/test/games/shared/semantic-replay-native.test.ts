import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import type { LapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { cacheDelete, cacheSet } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../../src/games/init";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { IRacingSourceFrameEncoder, type IRacingSourceFrameV3 } from "@raceiq/capture-formats/iracing/source-frame";
import { encodeMetaFrame, encodeParserBootstrapFrame, META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing";
import { iterateIRacingNativeFramesForTest, queryLapTelemetryBySemanticId, resolveTelemetryReplay } from "@raceiq/backend-core/telemetry/replay";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { canonicalizeTelemetryScalar } from "@raceiq/telemetry-core/telemetry/replay/canonicalize";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";

import { packet } from "@raceiq/telemetry-core/test-support/telemetry/resolver";
initGameAdapters();
initServerGameAdapters();

function frame(sessionTick: number, sessionState: number): IRacingSourceFrameV3 {
  return {
    schemaVersion: 3,
    session: {
      sessionId: 202,
      subSessionId: 205,
      sessionNum: 1,
      driverCarIdx: 0,
      trackId: 99,
      trackName: "Replay Test Track",
      trackLengthM: 5000,
      sectorStarts: [0, 0.5],
      carId: 42,
      carName: "Replay Test Car",
      carClassId: 8,
      carClassName: "GT3",
      engineIdleRpm: 900,
      engineRedlineRpm: 8500,
      engineCylinderCount: 8,
    },
    values: {
      SessionTick: sessionTick,
      SessionTime: sessionTick / 60,
      SessionNum: 1,
      SessionState: sessionState,
      IsOnTrack: true,
      Speed: 72.5,
      Lap: 1,
      LapDist: 100,
      LapDistPct: 0.02,
      Lat: 52.123456,
      Lon: -2.987654,
      Alt: 143.25,
      OilTemp: 80 + sessionTick,
      Voltage: 12 + sessionTick / 10,
      PlayerCarMyIncidentCount: sessionTick === 2 ? 3 : 0,
    },
    sessionInfo: "WeekendInfo:\n  TrackLatitude: 52.5 m\n  TrackLongitude: -2.5 m\n  TrackAltitude: 140 m\n",
    sessionInfoUpdate: 1,
  };
}

function record(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length);
  return Buffer.concat([prefix, payload]);
}

for (const rawFrameCount of [0, 1, 3]) {
  test(`iRacing native replay yields exactly ${rawFrameCount} source frames`, () => {
    const encoder = new IRacingSourceFrameEncoder();
    const meta = Buffer.alloc(12);
    meta.writeUInt32LE(META_FRAME_MAGIC, 0);
    meta.writeUInt32LE(4, 4);
    const preceding = record(encoder.encode(frame(0, 1)));
    const replayFrames = Array.from({ length: rawFrameCount }, (_, index) => record(encoder.encode(frame(index + 1, 2))));
    const followingLapTrigger = record(encoder.encode(frame(999, 4)));
    const capture = Buffer.concat([meta, preceding, ...replayFrames, followingLapTrigger]);
    const source: LapReplaySource = {
      id: 1,
      sessionId: 1,
      createdAt: "2026-08-04 00:00:00",
      gameId: "iracing",
      rawFile: null,
      rawByteOffset: meta.length + preceding.length,
      rawFrameCount,
      captureFormatVersion: null,
    };

    const sessionTicks = Array.from(iterateIRacingNativeFramesForTest(source, capture), (values) => values.SessionTick);

    expect(sessionTicks).toEqual(Array.from({ length: rawFrameCount }, (_, index) => index + 1));
    expect(sessionTicks).not.toContain(999);
  });
}

test("iRacing native replay restores parser bootstrap before owned frames", () => {
  const encoder = new IRacingSourceFrameEncoder();
  const seedFrame = encoder.encode(frame(0, 1));
  const ownedFrame = encoder.encode(frame(1, 2));
  const game = getServerGame("iracing");
  const state = game.createParserState();
  if (state == null || !game.captureParserCheckpoint || !game.restoreParserCheckpoint) {
    throw new Error("iRacing parser checkpoint codec is unavailable");
  }
  game.tryParse(seedFrame, state);
  const checkpoint = game.captureParserCheckpoint(state);
  if (!checkpoint) throw new Error("iRacing parser checkpoint could not be captured");
  const meta = encodeMetaFrame();
  const bootstrap = encodeParserBootstrapFrame("iracing", checkpoint);
  const capture = Buffer.concat([meta, bootstrap, record(ownedFrame)]);
  const source: LapReplaySource = {
    id: 1,
    sessionId: 1,
    createdAt: "2026-08-04 00:00:00",
    gameId: "iracing",
    rawFile: null,
    rawByteOffset: meta.length + bootstrap.length,
    rawFrameCount: 1,
    captureFormatVersion: 1,
  };

  const sessionTicks = Array.from(iterateIRacingNativeFramesForTest(source, capture), (values) => values.SessionTick);
  expect(sessionTicks).toEqual([1]);
});

test("canonical replay values clone recursive boolean and string structures", () => {
  const source = {
    flags: [true, false],
    labels: ["primary", "alternate"],
    nested: { samples: [1, null] },
  };
  const canonical = canonicalizeTelemetryScalar(source, "diagnostics.test-structure");
  expect(canonical).toEqual(source);
  expect(canonical).not.toBe(source);
  source.flags[0] = false;
  expect(canonical).toEqual({
    flags: [true, false],
    labels: ["primary", "alternate"],
    nested: { samples: [1, null] },
  });
  expect(() => canonicalizeTelemetryScalar({ invalid: Number.NaN }, "diagnostics.test-structure")).toThrow("contains a non-finite number");
});

test("native-values replay skips non-native raw capture identity loading", async () => {
  const sessionId = await insertSession("1", "2", "f1-2025");
  const rawFile = `${process.env.DATA_DIR ?? "."}/semantic-replay-invalid-${Date.now()}.bin.gz`;
  let lapId: number | undefined;
  await Bun.write(rawFile, Buffer.from("not gzip"));
  try {
    await updateSessionRawFile(sessionId, rawFile, "test-detector");
    lapId = await insertLap(sessionId, 1, 1, true, 0, 0);
    cacheSet(lapId, [
      packet("f1-2025", { Speed: 10, TimestampMS: 1_000 }),
      packet("f1-2025", { Speed: 20, TimestampMS: 1_000 }),
      packet("f1-2025", { Speed: 30, TimestampMS: 1_017 }),
    ]);

    const replay = await queryLapTelemetryBySemanticId(lapId, ["motion.speed"], { rawCaptureRequirement: "native-values" });
    expect(replay?.envelopes).toHaveLength(3);
    expect(replay?.envelopes.map((envelope) => envelope.sequence)).toEqual([0n, 1n, 2n]);
    expect(replay?.envelopes.map((envelope) => envelope.values.find((value) => value.semanticId === "motion.speed")?.value)).toEqual([10, 20, 30]);

    expect(replay?.envelopes[0]?.rawReference).toBeUndefined();
  } finally {
    if (lapId != null) cacheDelete(lapId);
    await deleteSession(sessionId);
    try {
      unlinkSync(rawFile);
    } catch {}
  }
});
test("semantic replay aligns native session frames and hashes decompressed capture bytes", async () => {
  const encoder = new IRacingSourceFrameEncoder();
  const sessionFrame = encoder.encode(frame(1, 2));
  const telemetryFrame = encoder.encode(frame(2, 4));
  const converted = await convertSeedFramesToSparse("iracing", [sessionFrame, telemetryFrame]);
  const capture = readFileSync(converted.path);
  const rawByteOffset = 12;
  expect(capture.readUInt32LE(rawByteOffset)).toBe(sessionFrame.length);
  const rawFile = `${process.env.DATA_DIR ?? "."}/semantic-replay-${Date.now()}.bin.gz`;
  await Bun.write(rawFile, gzipSync(capture));

  const sessionId = await insertSession("42", "99", "iracing");
  try {
    await updateSessionRawFile(sessionId, rawFile, "test-detector");
    const lapId = await insertLap(sessionId, 1, 1, true, rawByteOffset, 2);

    const replay = await queryLapTelemetryBySemanticId(lapId, ["session.session-state", "motion.speed", "motion.latitude", "motion.longitude", "motion.altitude", "identity.track.latitude", "identity.track.longitude", "identity.track.altitude", "engine.oil-temperature", "engine.voltage", "race.player-incident-count"], { rawCaptureRequirement: "native-values" });
    expect(replay?.envelopes).toHaveLength(2);
    expect(replay?.envelopes.map((envelope) => envelope.values.find((value) => value.semanticId === "session.session-state")?.value)).toEqual([2, 4]);
    expect(replay?.envelopes.map((envelope) => envelope.values.find((value) => value.semanticId === "engine.oil-temperature")?.value)).toEqual([81, 82]);
    expect(replay?.envelopes.map((envelope) => envelope.values.find((value) => value.semanticId === "engine.voltage")?.value)).toEqual([12.1, 12.2]);
    expect(replay?.envelopes.map((envelope) => envelope.values.find((value) => value.semanticId === "race.player-incident-count")?.value)).toEqual([0, 3]);
    expect(replay?.envelopes[0].values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ semanticId: "motion.speed", value: 72.5, state: "ok" }),
        expect.objectContaining({ semanticId: "motion.latitude", value: 52.123456, state: "ok" }),
        expect.objectContaining({ semanticId: "motion.longitude", value: -2.987654, state: "ok" }),
        expect.objectContaining({ semanticId: "motion.altitude", value: 143.25, state: "ok" }),
        expect.objectContaining({ semanticId: "identity.track.latitude", value: 52.5, state: "ok" }),
        expect.objectContaining({ semanticId: "identity.track.longitude", value: -2.5, state: "ok" }),
        expect.objectContaining({ semanticId: "identity.track.altitude", value: 140, state: "ok" }),
      ]),
    );
    const expectedHash = `sha256:${createHash("sha256").update(capture).digest("hex")}`;
    for (const envelope of replay?.envelopes ?? []) {
      expect(envelope.rawReference).toEqual({
        objectId: `session:${sessionId}:raw-capture`,
        contentHash: expectedHash,
        contentEncoding: "identity",
        storageEncoding: "gzip",
        byteOffset: rawByteOffset,
        frameCount: 2,
      });
    }
  } finally {
    await deleteSession(sessionId);
    try {
      unlinkSync(rawFile);
    } catch {}
    converted.cleanup();
  }
});

test("native semantic replay matches trimmed and appended frames and rejects ambiguous or absent identities", () => {
  const encoder = new IRacingSourceFrameEncoder();
  const meta = Buffer.alloc(12);
  meta.writeUInt32LE(META_FRAME_MAGIC, 0);
  meta.writeUInt32LE(4, 4);
  const native = [frame(1, 2), frame(2, 2), frame(3, 2), frame(3, 2), frame(4, 2)];
  native[0].values.OilTemp = 81;
  native[1].values.OilTemp = 82;
  native[2].values.OilTemp = 83;
  native[3].values.OilTemp = 84;
  native[4].values.OilTemp = 85;
  native[0].values.Voltage = 12.1;
  native[1].values.Voltage = 12.2;
  native[2].values.Voltage = 12.3;
  native[3].values.Voltage = 12.4;
  native[4].values.Voltage = 12.5;
  native[0].values.PlayerCarMyIncidentCount = 0;
  native[1].values.PlayerCarMyIncidentCount = 1;
  native[2].values.PlayerCarMyIncidentCount = 2;
  native[3].values.PlayerCarMyIncidentCount = 3;
  native[4].values.PlayerCarMyIncidentCount = 4;
  const capture = Buffer.concat([meta, ...native.map((value) => record(encoder.encode(value)))]);
  const source: LapReplaySource = {
    id: 1, sessionId: 1, createdAt: "2026-08-04 00:00:00", gameId: "iracing",
    rawFile: null, rawByteOffset: meta.length, rawFrameCount: 4, captureFormatVersion: null,
  };
  const retained = [2, 3, 4, 5].map((tick) => packet("iracing", {
    sessionUID: "205:202:1",
    iracing: { sessionTick: tick } as TelemetryPacket["iracing"],
    CurrentRaceTime: tick / 60,
    TimestampMS: 1_790_000_000_000 + tick * 50,
  }));
  const replay = resolveTelemetryReplay(1, source, retained, [
    "engine.oil-temperature", "engine.voltage", "race.player-incident-count",
  ], { bytes: capture, contentHash: "test", storageEncoding: "identity" });
  expect(replay.envelopes[0].values.find((value) => value.semanticId === "engine.oil-temperature")?.value).toBe(82);
  expect(replay.envelopes[0].values.find((value) => value.semanticId === "engine.voltage")?.value).toBe(12.2);
  expect(replay.envelopes[0].values.find((value) => value.semanticId === "race.player-incident-count")?.value).toBe(1);
  expect(replay.envelopes[1].values.find((value) => value.semanticId === "engine.oil-temperature")).toMatchObject({ value: null, state: "missing" });
  expect(replay.envelopes[1].values.find((value) => value.semanticId === "race.player-incident-count")).toMatchObject({ value: null, state: "missing" });
  expect(replay.envelopes[2].values.find((value) => value.semanticId === "engine.oil-temperature")?.value).toBe(85);
  expect(replay.envelopes[2].values.find((value) => value.semanticId === "engine.voltage")?.value).toBe(12.5);
  expect(replay.envelopes[2].values.find((value) => value.semanticId === "race.player-incident-count")?.value).toBe(4);
  expect(replay.envelopes[3].values.find((value) => value.semanticId === "engine.oil-temperature")).toMatchObject({ value: null, state: "missing" });
});
