import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { F1StateAccumulator } from "@raceiq/game-f1-2025/f1-state";
import { f1ServerAdapter } from "@raceiq/game-f1-2025";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import {
  encodeFrameLength, encodeMetaFrame, encodeParserBootstrapFrame, encodeSessionClockAnchor,
  iterateSessionCaptureRecords, type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import {
  createNativeOnlineRecordingCodec, encodeNativeOnlineRecording,
  sanitizeF1ParserBootstrap,
} from "@raceiq/backend-core/session-capture/online-recording-codec";

registerServerGame(f1ServerAdapter);
const codec = createNativeOnlineRecordingCodec("f1-2025");
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const nativePacketLengths: Record<number, number> = { 0: 1349, 1: 753, 2: 1285, 4: 1284, 5: 1133, 6: 1352 };
function nativeFrame(packetId: number, payload?: Buffer) {
  const frame = Buffer.alloc(nativePacketLengths[packetId] ?? 29);
  frame.writeUInt16LE(2025, 0); frame[2] = 25; frame[5] = 1; frame[6] = packetId;
  frame.writeBigUInt64LE(123n, 7); frame.writeFloatLE(20, 15);
  if (payload) payload.copy(frame, 29);
  return frame;
}
function checkpointWithSetup() {
  const checkpoint = JSON.parse(Buffer.from(new F1StateAccumulator().captureCheckpoint()).toString("utf8"));
  checkpoint.participants = [{ driverId: 7, teamId: 1, name: "Native driver", aiControlled: 0, networkId: 255 }];
  checkpoint.carSetup = Object.fromEntries([
    "frontWing", "rearWing", "onThrottle", "offThrottle", "frontCamber", "rearCamber",
    "frontToe", "rearToe", "frontSuspension", "rearSuspension", "frontAntiRollBar",
    "rearAntiRollBar", "frontRideHeight", "rearRideHeight", "brakePressure", "brakeBias",
    "engineBraking", "rearLeftTyrePressure", "rearRightTyrePressure", "frontLeftTyrePressure",
    "frontRightTyrePressure", "fuelLoad",
  ].map(key => [key, 1]));
  return checkpoint;
}
function recording(bootstrap: Buffer, frames: Buffer[]) {
  return Buffer.concat([
    encodeMetaFrame(frames.length), encodeParserBootstrapFrame("f1-2025", bootstrap),
    ...frames.flatMap(frame => [encodeFrameLength(frame.length, 20_000), frame]),
  ]);
}

describe("Online native recording privacy boundary", () => {
  test("F1 recording codec preserves World car41 scope without changing native parser behavior", async () => {
    for (const teamId of [41, 1]) {
      const participants = Buffer.alloc(58);
      participants[0] = 1;
      participants[2] = 8;
      participants[3] = 255;
      participants[4] = teamId;
      const frames = [
        nativeFrame(0, Buffer.alloc(60)), nativeFrame(1, Buffer.alloc(9)),
        nativeFrame(2, Buffer.alloc(57)), nativeFrame(4, participants),
        nativeFrame(6, Buffer.alloc(60)),
      ];
      const bytes = Buffer.concat([encodeMetaFrame(frames.length), encodeSessionClockAnchor(20_000, 1_700_000_000_000),
        ...frames.flatMap(frame => [encodeFrameLength(frame.length, 20_000), frame])]);
      expect(await codec.isServiceCompatible(bytes, "f1-2025")).toBe(teamId === 41);
      const state = new F1StateAccumulator();
      let localCarId: string | undefined;
      for (const frame of frames) {
        const packet = f1ServerAdapter.tryParse(frame, state, 20_000);
        if (packet) localCarId = packet.carId;
      }
      expect(localCarId).toBe(String(teamId));
    }
  });

  test("strips both cached setup and native setup packets without changing original or participants", async () => {
    const snapshot = checkpointWithSetup();
    const source = gzipSync(recording(Buffer.from(JSON.stringify(snapshot)), [nativeFrame(5), nativeFrame(4)]));
    const originalHash = checksum(source);
    expect(await codec.hasF1SetupTelemetry(source)).toBe(true);
    const sanitized = await codec.stripF1SetupTelemetry(source);
    expect(sanitized).not.toBeNull();
    expect(checksum(source)).toBe(originalHash);
    expect(await codec.hasF1SetupTelemetry(sanitized!)).toBe(false);
    const records = [...iterateSessionCaptureRecords(gunzipSync(sanitized!), 12, { strict: true })];
    const bootstrap = records.find(record => record.kind === "parser-bootstrap");
    expect(bootstrap?.kind).toBe("parser-bootstrap");
    if (bootstrap?.kind !== "parser-bootstrap") throw new Error("Missing parser bootstrap");
    const restored = JSON.parse(bootstrap.payload.toString("utf8"));
    expect(restored).toEqual({ ...snapshot, carSetup: null });
    expect(records.filter(record => record.kind === "frame").map(record => record.frame[6])).toEqual([4]);
  });

  test("streaming sanitation preserves native bytes and source clocks, not replay time", async () => {
    const frames = [nativeFrame(4), nativeFrame(5), nativeFrame(6)];
    const before = frames.map(checksum);
    const times = [20_000, 20_017, 20_034];
    async function* source(): AsyncGenerator<SessionCaptureRecord> {
      yield { kind: "clock-anchor", offset: 0, endOffset: 0, frameTimeMs: 20_000, utcTimeMs: 1_700_000_000_000 };
      for (let index = 0; index < frames.length; index++) {
        yield { kind: "frame", offset: 100 + index * 100, endOffset: 200 + index * 100,
          frame: frames[index]!, frameTimeMs: times[index]! };
      }
    }
    const bytes = await encodeNativeOnlineRecording(source(), "f1-2025");
    const anchor = [...iterateSessionCaptureRecords(bytes, 12, { strict: true })].find(record => record.kind === "clock-anchor");
    expect(anchor).toMatchObject({ frameTimeMs: 20_000, utcTimeMs: 1_700_000_000_000 });
    const retained = [...iterateSessionCaptureRecords(bytes, 12, { strict: true })]
      .filter(record => record.kind === "frame");
    expect(retained.map(record => checksum(record.frame))).toEqual([before[0], before[2]]);
    expect(retained.map(record => record.frameTimeMs)).toEqual([20_000, 20_034]);
    expect(frames.map(checksum)).toEqual(before);
    expect(await codec.hasF1SetupTelemetry(bytes)).toBe(false);
  });

  test("rejects unknown checkpoint fields and versions rather than claiming sanitation", async () => {
    for (const change of [{ version: 2 }, { futureSetupCache: { setup: "private" } }]) {
      const source = recording(Buffer.from(JSON.stringify({ ...checkpointWithSetup(), ...change })), [nativeFrame(4)]);
      expect(await codec.stripF1SetupTelemetry(source)).toBeNull();
      expect(await codec.hasF1SetupTelemetry(source)).toBe(true);
    }
  });

  test("preserves source UID and rejects malformed cached native state", () => {
    const snapshot = checkpointWithSetup();
    snapshot.sessionUID = "18446744073709551615";
    const sanitized = sanitizeF1ParserBootstrap(Buffer.from(JSON.stringify(snapshot)));
    expect(JSON.parse(sanitized.toString("utf8")).sessionUID).toBe(snapshot.sessionUID);
    snapshot.participants[0].aiControlled = 3;
    expect(() => sanitizeF1ParserBootstrap(Buffer.from(JSON.stringify(snapshot)))).toThrow("f1_sanitization_failed");
  });

  test("rejects mislabeled Forza, trailing bytes and hidden metadata", async () => {
    const forza = Buffer.alloc(331);
    const source = Buffer.concat([encodeMetaFrame(1), encodeFrameLength(forza.length), forza]);
    for (const gameId of ["acc", "ac-evo", "f1-2025", "iracing", "lmu"] as const) {
      expect(await createNativeOnlineRecordingCodec(gameId).isServiceCompatible(source, gameId)).toBe(false);
    }
    const framed = recording(Buffer.from(JSON.stringify(checkpointWithSetup())), [nativeFrame(4)]);
    expect(await codec.isServiceCompatible(Buffer.concat([framed, Buffer.from([1])]), "f1-2025")).toBe(false);
    const hidden = Buffer.alloc(16);
    hidden.writeUInt32LE(0xffffffff, 0); hidden.writeUInt32LE(8, 4); hidden.writeUInt32LE(1234, 8);
    expect(await codec.isServiceCompatible(Buffer.concat([framed, hidden]), "f1-2025")).toBe(false);
  });

  test("setup-only input still yields restrictive messages before preparation finishes", async () => {
    let restrictionProcessed = false;
    setImmediate(() => { restrictionProcessed = true; });
    async function* records(): AsyncGenerator<SessionCaptureRecord> {
      for (let index = 0; index < 257; index++) {
        if (index === 256) expect(restrictionProcessed).toBe(true);
        yield { kind: "frame", offset: index * 68, endOffset: index * 68 + 68,
          frame: nativeFrame(index === 256 ? 4 : 5), frameTimeMs: 20_000 };
      }
    }
    const bytes = await encodeNativeOnlineRecording(records(), "f1-2025");
    const retained = [...iterateSessionCaptureRecords(bytes, 12, { strict: true })]
      .filter(record => record.kind === "frame");
    expect(retained.map(record => record.frame[6])).toEqual([4]);
  });

  test("streaming producer rejects foreign-game frames instead of passing SourceUnknown", async () => {
    async function* records(): AsyncGenerator<SessionCaptureRecord> {
      yield { kind: "frame", offset: 12, endOffset: 347, frame: Buffer.alloc(331) };
    }
    await expect(encodeNativeOnlineRecording(records(), "f1-2025")).rejects.toThrow("unsupported_recording_format");
  });
});
