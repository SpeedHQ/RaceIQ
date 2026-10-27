import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AMS2_DUMP_MAGIC, readAMS2DumpFrames, readAMS2DumpFramesFromBuffer } from "@raceiq/capture-formats/ams2/dump";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { registerServerGame } from "@raceiq/backend-core/games/registry";
import { registerGame } from "@raceiq/shared/games/registry";
import { detectGameIdFromBuffer, importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { AMS2TelemetrySource } from "../src/source";
import { AMS2DumpRecorder } from "../src/recorder";
import { AMS2SharedMemoryReader } from "../src/memory-reader";
import { encodeAMS2Frame, decodeAMS2Frame } from "../src/frame";
import { ams2ServerAdapter } from "../src/index";
import { AMS2_LAYOUT as L, AMS2_MEMORY_SIZE, PARTICIPANT_OFFSET as P } from "../src/layout";

registerServerGame(ams2ServerAdapter);
registerGame(ams2ServerAdapter);

function memoryFixture(): Buffer {
  const memory = Buffer.alloc(16384);
  memory.writeUInt32LE(14, L.mVersion);
  memory.writeUInt32LE(2, L.mGameState);
  memory.writeUInt32LE(5, L.mSessionState);
  memory.writeInt32LE(1, L.mNumParticipants);
  memory[P] = 1;
  memory.write("Formula Ultimate", L.mCarName);
  memory.write("Interlagos", L.mTrackLocation);
  memory.writeFloatLE(3000, L.mTrackLength);
  memory.writeUInt32LE(1, P + 92);
  memory.writeFloatLE(50, L.mSpeed);
  memory.fill(0xa5, AMS2_MEMORY_SIZE); // Undecoded source extensions must survive.
  return memory;
}

describe("AMS2 dump-mode capture", () => {
  test("retains stale qualifying-to-race bytes without creating an extra live session", async () => {
    let memory = memoryFixture();
    const dumped: Buffer[] = [];
    const db = new CapturingDbAdapter();
    const detector = ams2ServerAdapter.createLapDetector({ db });
    const source = new AMS2TelemetrySource({
      recordingEnabled: true,
      recorder: {
        recording: true, start: () => "unused", flush() {}, async stop() {},
        writeFrame: raw => { dumped.push(Buffer.from(raw)); },
      },
      reader: { start() {}, async stop() {}, readLatest: () => memory },
      registerIdentity: async () => {},
      dispatchRawFrame: async raw => { await detector.feed(ams2ServerAdapter.tryParse(raw, null)!); },
    });
    try {
      memory.writeUInt32LE(3, L.mSessionState);
      memory.writeUInt32LE(3, L.mRaceState);
      memory.writeUInt32LE(5, P + 92);
      memory.writeFloatLE(64, L.mLastLapTime);
      expect(await source.pollOnce()).toBe(true);
      expect(db.sessions).toHaveLength(1);
      memory.writeUInt32LE(5, L.mSessionState);
      memory.writeUInt32LE(2, L.mSequenceNumber);
      expect(await source.pollOnce()).toBe(false);
      expect(db.sessions).toHaveLength(1);
      expect(source.getDiagnostics().staleTransition).toBe(1);
      expect(decodeAMS2Frame(dumped[1])!.memory.equals(memory)).toBe(true);
      memory = memoryFixture();
      memory.writeUInt32LE(1, L.mRaceState);
      memory.writeUInt32LE(4, L.mSequenceNumber);
      expect(await source.pollOnce()).toBe(true);
      expect(db.sessions).toHaveLength(2);
      expect(db.sessions.map(session => session.sessionType)).toEqual(["qualifying", "race"]);
      // Finishing the current race is still accepted.
      memory.writeUInt32LE(3, L.mRaceState);
      memory.writeUInt32LE(6, L.mSequenceNumber);
      expect(await source.pollOnce()).toBe(true);
      expect(dumped).toHaveLength(4);
    } finally {
      await source.stop();
      await detector.finalizeCurrentSession?.();
    }
  });
  test("opens before session entry and restores full source bytes from raw and gzip streams", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ams2-dump-"));
    const recorder = new AMS2DumpRecorder();
    try {
      const path = recorder.start(directory);
      expect(readFileSync(path).subarray(0, 8)).toEqual(AMS2_DUMP_MAGIC);
      const menu = memoryFixture();
      menu.writeUInt32LE(1, L.mGameState);
      menu.writeInt32LE(0, L.mNumParticipants);
      const frames = [menu, memoryFixture(), menu].map((m, i) => encodeAMS2Frame(m, 1800000000000 + i * 10, i < 1 ? 1 : 2));
      for (const frame of frames) recorder.writeFrame(frame);
      await recorder.stop();
      expect(recorder.recording).toBe(false);
      expect([...readAMS2DumpFramesFromBuffer(readFileSync(path))]).toEqual(frames);
      const gzipPath = path + ".gz";
      writeFileSync(gzipPath, gzipSync(readFileSync(path)));
      const restored: Buffer[] = [];
      for await (const frame of readAMS2DumpFrames(gzipPath)) restored.push(frame);
      expect(restored).toEqual(frames);
      expect(decodeAMS2Frame(restored[1])!.memory.subarray(AMS2_MEMORY_SIZE)).toEqual(memoryFixture().subarray(AMS2_MEMORY_SIZE));
      expect(detectGameIdFromBuffer(readFileSync(gzipPath))).toBe("ams2");
      expect(() => [...readAMS2DumpFramesFromBuffer(readFileSync(path).subarray(0, -1))]).toThrow("Truncated");
      const badVersion = Buffer.from(readFileSync(path));
      badVersion.writeUInt32LE(99, 8);
      expect(() => [...readAMS2DumpFramesFromBuffer(badVersion)]).toThrow("version");
      const badCount = Buffer.from(readFileSync(path));
      badCount.writeUInt32LE(9, 12);
      expect(() => [...readAMS2DumpFramesFromBuffer(badCount)]).toThrow("count");
    } finally {
      await recorder.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains pre/post-session source frames and finalises from the menu transition before EOF", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ams2-lifecycle-"));
    const recorder = new AMS2DumpRecorder();
    let memory = memoryFixture();
    memory.writeUInt32LE(1, L.mGameState);
    memory.writeInt32LE(0, L.mNumParticipants);
    const db = new CapturingDbAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new CapturingWsAdapter(), { bypassPacketRateFilter: true, recorder: new NullSessionRecorderAdapter() });
    let ended = 0;
    const source = new AMS2TelemetrySource({
      recordingEnabled: true,
      recordingDir: directory,
      recorder,
      pollIntervalMs: 3600000,
      reader: { start() {}, async stop() {}, readLatest: () => memory },
      registerIdentity: async () => {},
      dispatchRawFrame: async (frame, time) => {
        const packet = ams2ServerAdapter.tryParse(frame, null);
        if (packet) await pipeline.processPacket(packet, frame, time);
      },
      onSessionEnd: async () => {
        ended++;
        await pipeline.finalizeCurrentSession();
      },
    });
    try {
      source.start();
      expect(await source.pollOnce()).toBe(false);
      expect(db.sessions).toHaveLength(0);
      for (let lap = 1; lap <= 2; lap++) {
        for (let i = 0; i < 300; i++) {
          memory = memoryFixture();
          memory.writeUInt32LE(lap, P + 92);
          memory.writeUInt32LE(lap - 1, P + 88);
          memory.writeFloatLE(i * 10, P + 80);
          memory.writeFloatLE(i * 0.2, L.mCurrentTime);
          memory.writeFloatLE(lap > 1 ? 60 : 0, L.mLastLapTime);
          memory.writeUInt32LE((lap * 300 + i) * 2, L.mSequenceNumber);
          expect(await source.pollOnce()).toBe(true);
        }
      }
      for (let i = 0; i < 60; i++) {
        memory = memoryFixture();
        memory.writeUInt32LE(3, P + 92);
        memory.writeUInt32LE(2, P + 88);
        memory.writeFloatLE(i * 10, P + 80);
        memory.writeFloatLE(i * 0.2, L.mCurrentTime);
        memory.writeFloatLE(60, L.mLastLapTime);
        memory.writeUInt32LE(2000 + i * 2, L.mSequenceNumber);
        await source.pollOnce();
      }
      expect(db.sessions).toHaveLength(1);
      // Native states 6/7 are in-game/front-end replay, not game exit.
      for (const state of [6, 7]) {
        memory.writeUInt32LE(state, L.mGameState);
        expect(await source.pollOnce()).toBe(false);
        expect(ended).toBe(0);
      }
      memory.writeUInt32LE(1, L.mGameState);
      memory.writeInt32LE(0, L.mNumParticipants);
      // Menus may change state without advancing the driving sequence.
      expect(await source.pollOnce()).toBe(false);
      expect(ended).toBe(1);
      expect(pipeline.lapDetector?.session).toBeNull();
      expect(db.laps.filter((l) => l.isValid)).toHaveLength(2);
      expect(db.laps.at(-1)?.isValid).toBe(false);
      const saved = db.laps.length;
      memory.writeUInt32LE(memory.readUInt32LE(L.mSequenceNumber) + 2, L.mSequenceNumber);
      await source.pollOnce();
      expect(ended).toBe(1);
      expect(db.laps).toHaveLength(saved);
      await source.stop();
      const files = new Bun.Glob("ams2-*.bin").scanSync({ cwd: directory, absolute: true });
      const path = [...files][0];
      const bytes = readFileSync(path);
      const frames = [...readAMS2DumpFramesFromBuffer(bytes)];
      expect(frames).toHaveLength(665);
      expect(ams2ServerAdapter.tryParse(frames[0], null)).toBeNull();
      expect(ams2ServerAdapter.isSessionEndFrame!(frames.at(-1)!)).toBe(true);
      const result = await importSessionBin(gzipSync(bytes), "ams2", { notifyDriverProfile: false });
      expect(result.packetCount).toBe(660);
      expect(result.laps).toHaveLength(3);
      expect(result.laps.filter((l) => l.isValid)).toHaveLength(2);
      expect(new Set(result.laps.map((l) => l.sessionId)).size).toBe(1);
    } finally {
      await source.stop();
      await pipeline.finalizeCurrentSession();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("sparse production recordings preserve extended frames across checkpoints and size changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ams2-extended-"));
    const recorder = new SparseSessionRecorder("ams2");
    try {
      const path = join(directory, "canonical.bin");
      recorder.start(path);
      recorder.writeMetaFrame();
      const expected: Buffer[] = [];
      for (let i = 0; i < 270; i++) {
        const memory = i < 140 ? memoryFixture() : memoryFixture().subarray(0, AMS2_MEMORY_SIZE);
        memory.writeUInt32LE(i * 2, L.mSequenceNumber);
        const frame = encodeAMS2Frame(memory, 1800000000000 + i * 10, 2);
        expected.push(frame);
        recorder.writeRecord(frame, 1800000000000 + i * 10);
      }
      await recorder.stop();
      expect([...iterateSessionFrames(readFileSync(path))]).toEqual(expected);
    } finally {
      await recorder.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32" || process.arch !== "x64")("native reader preserves the complete mapped region beyond the decoded prefix", async () => {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      CreateFileMappingW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
      MapViewOfFile: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.ptr },
      RtlCopyMemory: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
      UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    });
    const name = Buffer.from(`raceiq-ams2-test-${crypto.randomUUID()}\0`, "utf16le");
    const handle = lib.symbols.CreateFileMappingW(-1, null, 4, 0, 16384, ptr(name));
    expect(handle).toBeTruthy();
    const view = lib.symbols.MapViewOfFile(handle, 0x000f001f, 0, 0, 0);
    expect(view).toBeTruthy();
    const memory = memoryFixture();
    memory.writeUInt32LE(2, L.mSequenceNumber);
    lib.symbols.RtlCopyMemory(view, ptr(memory), memory.length);
    const reader = new AMS2SharedMemoryReader(name.toString("utf16le").replace(/\0$/, ""));
    try {
      reader.start();
      expect(reader.connected).toBe(true);
      expect(reader.readLatest()).toEqual(memory);
      memory.writeUInt32LE(3, L.mSequenceNumber);
      lib.symbols.RtlCopyMemory(view, ptr(memory), memory.length);
      expect(reader.readLatest()).toBeNull();
      expect(reader.getDiagnostics()).toMatchObject({ accepted: 1, writerBusy: 1 });
    } finally {
      await reader.stop();
      if (view) lib.symbols.UnmapViewOfFile(view);
      if (handle) lib.symbols.CloseHandle(handle);
      lib.close();
    }
  });
});
