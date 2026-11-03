import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client, readClient, db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { setDumpOnlyTelemetryRouting } from "@raceiq/backend-core/telemetry/live-pipeline";
import { LMUTelemetrySource } from "@raceiq/game-lmu/source";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE } from "@raceiq/capture-formats/lmu/layout";
import { isLiveTelemetrySchemaMessageV1, isLiveTelemetryFrameMessageV1, isDevTelemetryPacketMessageV1, isDevTelemetrySubscriptionMessageV1, type LiveTelemetrySchemaMessageV1 } from "@raceiq/shared/telemetry/live/contracts";
import { initServerGameAdapters } from "../../src/games/init";
import { startHttpServer } from "../../src/runtime/http-server";
import { createHttpAccess } from "../../src/runtime/http-access";
import app from "../../src/routes/index";
import { AccSharedMemoryReader } from "@raceiq/game-acc/shared-memory";
import { AcEvoSharedMemoryReader } from "@raceiq/game-ac-evo/shared-memory";
import { AC_STATUS, GRAPHICS, PHYSICS } from "@raceiq/capture-formats/acc/structs";
import { ACEVO_STATUS, GRAPHICS_EVO } from "@raceiq/capture-formats/ac-evo/structs";
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { KunosRecorder } from "@raceiq/backend-core/games/kunos/recorder";
import { ReplayedKunosMemoryReader } from "@raceiq/backend-core/test-support/recordings/replayed-kunos-memory-reader";
import { IRacingTelemetrySource } from "@raceiq/game-iracing/source";
import { IRacingRecorder } from "@raceiq/game-iracing/recorder";
import { readIRacingFrames } from "@raceiq/capture-formats/iracing/dump";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame } from "@raceiq/capture-formats/iracing/source-frame";

test("dump mode writes one continuous native BIN and publishes live WebSocket telemetry without DB calls", async () => {
  initServerGameAdapters();
  const directory = await mkdtemp(join(tmpdir(), "raceiq-dump-only-"));
  const beforeSessions = await db.select().from(sessions).all();
  const beforeLaps = await db.select().from(laps).all();
  const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);
  memory.writeInt32LE(42, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.id);
  memory.write("Ferrari 499P", LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.vehicleName);
  memory.write("Circuit de Spa-Francorchamps", LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.trackName);
  memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
  memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session); // Practice.
  memory.writeInt32LE(42, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.id);
  memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.isPlayer);
  const source = new LMUTelemetrySource({ reader: { start() {}, async stop() {}, readLatest: () => memory }, recordingEnabled: true, recordingDir: directory, rest: false, pollIntervalMs: 60_000 });
  const server = startHttpServer({ app, port: 0, staticDir: null, devPublicDir: null, access: await createHttpAccess({ NODE_ENV: "production" }) });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const opened = Promise.withResolvers<void>();
  const subscribed = Promise.withResolvers<void>();
  const received = new Map<number, { live: boolean; dev: boolean; complete: PromiseWithResolvers<void> }>();
  for (const rpm of [5100, 6200, 7300, 8031]) received.set(rpm, { live: false, dev: false, complete: Promise.withResolvers<void>() });
  let schema: LiveTelemetrySchemaMessageV1 | undefined;
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("Dump WebSocket connection failed"));
  socket.onmessage = ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (isLiveTelemetrySchemaMessageV1(message)) schema = message;
    if (isDevTelemetrySubscriptionMessageV1(message)) {
      if (message.subscribed) subscribed.resolve();
      else subscribed.reject(new Error(`Dev subscription rejected: ${message.error}`));
    }
    if (isLiveTelemetryFrameMessageV1(message, schema) && schema) {
      const rpm = message.values[schema.definitions.findIndex(definition => definition.semanticId === "engine.rpm")];
      if (typeof rpm === "number") {
        const sample = received.get(rpm);
        if (sample) { expect(message.sessionId).toBeNull(); sample.live = true; if (sample.dev) sample.complete.resolve(); }
      }
    }
    if (isDevTelemetryPacketMessageV1(message)) {
      const sample = received.get(message.packet.CurrentEngineRpm);
      if (sample) { sample.dev = true; if (sample.live) sample.complete.resolve(); }
    }
  };
  let writeQueries: { mockRestore(): void } | undefined;
  let readQueries: { mockRestore(): void } | undefined;
  try {
    await opened.promise;
    socket.send(JSON.stringify({ type: "subscribe", channel: "dev-telemetry" }));
    await subscribed.promise;
    setDumpOnlyTelemetryRouting(true);
    source.start();
    writeQueries = spyOn(client, "execute").mockImplementation(() => { throw new Error("Dump telemetry called write DB client"); });
    readQueries = spyOn(readClient, "execute").mockImplementation(() => { throw new Error("Dump telemetry called read DB client"); });
    for (const [index, rpm] of [5100, 6200, 7300].entries()) {
      if (index === 2) {
        memory.writeUInt8(1, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.inGarageStall);
        expect(await source.pollOnce()).toBe(false);
        memory.writeUInt8(0, LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.inGarageStall);
      }
      memory.writeDoubleLE(20 + index, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      memory.writeDoubleLE(20 + index, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
      memory.writeDoubleLE(rpm, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineRpm);
      expect(await source.pollOnce()).toBe(true);
      await received.get(rpm)!.complete.promise;
    }
    // No WebSocket pacing: cumulative raw frames must exceed the bounded writer queue.
    const burstRpm = Array.from({ length: 32 }, (_, index) => 8000 + index);
    for (const [index, rpm] of burstRpm.entries()) {
      memory.writeDoubleLE(100 + index, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      memory.writeDoubleLE(100 + index, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
      memory.writeDoubleLE(rpm, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.engineRpm);
      expect(await source.pollOnce()).toBe(true);
    }
    await received.get(8031)!.complete.promise;
    await source.stop();
    expect(writeQueries).not.toHaveBeenCalled();
    expect(readQueries).not.toHaveBeenCalled();
    writeQueries.mockRestore(); readQueries.mockRestore();
    writeQueries = undefined; readQueries = undefined;
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const recorded = readLMUFrames(join(directory, files[0]!));
    expect(recorded.map(frame => decodeLMUSourceFrame(frame)!.telemetry.readDoubleLE(LMU_TELEMETRY.engineRpm))).toEqual([5100, 6200, 7300, ...burstRpm]);
    expect(recorded.map(frame => decodeLMUSourceFrame(frame)!.sessionEvent)).toEqual(Array(35).fill(0));
    expect(decodeLMUSourceFrame(recorded[0]!)!.lmuContext!.key.sessionKey).not.toBe(decodeLMUSourceFrame(recorded[2]!)!.lmuContext!.key.sessionKey);
    expect(await db.select().from(sessions).all()).toEqual(beforeSessions);
    expect(await db.select().from(laps).all()).toEqual(beforeLaps);
  } finally {
    await source.stop();
    writeQueries?.mockRestore(); readQueries?.mockRestore();
    setDumpOnlyTelemetryRouting(false);
    socket.close();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

for (const game of ["acc", "ac-evo"] as const) {
  test(`${game} dump writes original shared-memory pages and live WebSocket values without DB calls`, async () => {
    initServerGameAdapters();
    const fixture = game === "acc"
      ? "test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz"
      : "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";
    const input = readKunosFrames(fixture).filter(frame => game === "acc"
      ? frame.graphics.readInt32LE(GRAPHICS.status.offset) === AC_STATUS.AC_LIVE
      : frame.graphics.readInt32LE(GRAPHICS_EVO.status.offset) === ACEVO_STATUS.AC_LIVE).slice(0, 5);
    const directory = await mkdtemp(join(tmpdir(), `raceiq-${game}-dump-live-`));
    const memoryReader = new ReplayedKunosMemoryReader(input);
    const recorder = new KunosRecorder();
    const options = { recordingEnabled: true, memoryReader, recorder, recordingDir: directory, enableMetrics: false };
    const source = game === "acc" ? new AccSharedMemoryReader(options) : new AcEvoSharedMemoryReader(options);
    const expectedRpm = input.at(-1)!.physics.readInt32LE(PHYSICS.rpms.offset);
    const server = startHttpServer({ app, port: 0, staticDir: null, devPublicDir: null, access: await createHttpAccess({ NODE_ENV: "production" }) });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const opened = Promise.withResolvers<void>();
    const displayed = Promise.withResolvers<void>();
    let schema: LiveTelemetrySchemaMessageV1 | undefined;
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error("Dump WebSocket connection failed"));
    socket.onmessage = ({ data }) => {
      const message: unknown = JSON.parse(String(data));
      if (isLiveTelemetrySchemaMessageV1(message)) schema = message;
      if (schema?.simulator === game && isLiveTelemetryFrameMessageV1(message, schema)) {
        const rpm = message.values[schema.definitions.findIndex(definition => definition.semanticId === "engine.current-engine-rpm")];
        if (rpm === expectedRpm) { expect(message.sessionId).toBeNull(); displayed.resolve(); }
      }
    };
    let writes: { mockRestore(): void } | undefined;
    let reads: { mockRestore(): void } | undefined;
    try {
      await opened.promise;
      setDumpOnlyTelemetryRouting(true);
      writes = spyOn(client, "execute").mockImplementation(() => { throw new Error("Native dump called DB"); });
      reads = spyOn(readClient, "execute").mockImplementation(() => { throw new Error("Native dump called read DB"); });
      source.start();
      await memoryReader.exhausted;
      await source.stop();
      await displayed.promise;
      expect(writes).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      expect(await readdir(directory)).toHaveLength(1);
      expect(readKunosFrames(recorder.path!)).toEqual(input);
    } finally {
      await source.stop();
      writes?.mockRestore(); reads?.mockRestore();
      setDumpOnlyTelemetryRouting(false);
      socket.close(); server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
}

test("iRacing dump publishes live telemetry and retains SDK source values without DB calls", async () => {
  initServerGameAdapters();
  const directory = await mkdtemp(join(tmpdir(), "raceiq-iracing-dump-live-"));
  const values = { SessionTime: 1, SessionTick: 1, SessionNum: 0, SessionState: 4, IsOnTrack: true, OnPitRoad: false, PlayerTrackSurface: 3, Speed: 30, RPM: 5100, Throttle: 0.5, Brake: 0, Gear: 3, Lap: 1, LapCompleted: 0, LapDistPct: 0.1, FuelLevel: 50 };
  const snapshot = {
    tick: 1, sessionInfoUpdate: 1, values,
    sessionInfo: "WeekendInfo:\n  TrackID: 126\n  TrackLength: 4 km\n  TrackDisplayName: Test Raceway\n  SessionID: 1\n  SubSessionID: 2\nDriverInfo:\n  DriverCarIdx: 0\n  DriverCarIdleRPM: 2000\n  DriverCarRedLine: 8000\n  DriverCarEngCylinderCount: 6\n  Drivers:\n  - CarIdx: 0\n    CarID: 42\n    CarScreenName: Test GT3\n    CarClassID: 3\n    CarClassShortName: GT3\n",
  };
  const recorder = new IRacingRecorder();
  const source = new IRacingTelemetrySource({ reader: { start() {}, async stop() {}, readLatest: () => snapshot }, recorder, recordingEnabled: true, recordingDir: directory, pollIntervalMs: 60_000 });
  const server = startHttpServer({ app, port: 0, staticDir: null, devPublicDir: null, access: await createHttpAccess({ NODE_ENV: "production" }) });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const opened = Promise.withResolvers<void>();
  const displayed = Promise.withResolvers<void>();
  let schema: LiveTelemetrySchemaMessageV1 | undefined;
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("iRacing dump WebSocket failed"));
  socket.onmessage = ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (isLiveTelemetrySchemaMessageV1(message)) schema = message;
    if (schema?.simulator === "iracing" && isLiveTelemetryFrameMessageV1(message, schema)) {
      const rpm = message.values[schema.definitions.findIndex(definition => definition.semanticId === "engine.current-engine-rpm")];
      if (rpm === 5100) { expect(message.sessionId).toBeNull(); displayed.resolve(); }
    }
  };
  let writes: { mockRestore(): void } | undefined;
  let reads: { mockRestore(): void } | undefined;
  try {
    await opened.promise;
    setDumpOnlyTelemetryRouting(true);
    source.start();
    writes = spyOn(client, "execute").mockImplementation(() => { throw new Error("iRacing dump called DB"); });
    reads = spyOn(readClient, "execute").mockImplementation(() => { throw new Error("iRacing dump called read DB"); });
    expect(await source.pollOnce()).toBe(true);
    await displayed.promise;
    await source.stop();
    expect(writes).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(await readdir(directory)).toHaveLength(1);
    const decoder = createIRacingSourceDecoderState();
    const frames = readIRacingFrames(recorder.path!).map(frame => decodeIRacingSourceFrame(frame, decoder));
    expect(frames.map(frame => frame?.values)).toEqual([values]);
  } finally {
    await source.stop();
    writes?.mockRestore(); reads?.mockRestore();
    setDumpOnlyTelemetryRouting(false);
    socket.close(); server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
