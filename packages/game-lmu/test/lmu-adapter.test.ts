import { temporaryDirectory, createLMUDuckDB } from "./support/duckdb";
import { describe, expect, test } from "bun:test";


import { join } from "node:path";


import {
  resolveLMUCar,
  resolveLMUTrack,
} from "@raceiq/shared/games/lmu/catalog";
import { resolveLMUInvalidReason } from "../src/lap-policy";
import { loadLabelledSegments } from "@raceiq/shared/racing/tracks/storage/meta";
import { lmuServerAdapter } from "../src/index";
import { CapturingDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "@raceiq/shared/telemetry/resolver/compile";

import {
  previewLMUDuckDB,
  readLMUDuckDBFrames,
} from "../src/import-duckdb";
import {
  LMU_GAME_VERSION_OFFSET,
  LMU_SCORING_INFO,
  LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_VEHICLE,
  LMU_SCORING_VEHICLE_SIZE,
  LMU_SCORING_VEHICLES_OFFSET,
  LMU_SESSION_EVENT_OFFSET,
  LMU_SHARED_MEMORY_SIZE,
  LMU_TELEMETRY,
  LMU_TELEMETRY_HEADER_OFFSET,
  LMU_TELEMETRY_INFO_OFFSET,
  LMU_WHEEL,
  LMU_WHEEL_SIZE,
} from "@raceiq/capture-formats/lmu/layout";
import { LMURecorder } from "../src/recorder";
import { readLMUFrames } from "@raceiq/capture-formats/lmu/dump";
import { LMUTelemetrySource } from "../src/source";
import {
  canHandleLMUSourceFrame,
  decodeLMUSourceFrame,
  encodeLMUSourceFrame,
} from "@raceiq/capture-formats/lmu/source-frame";







function writeCString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length - 1);
}

function lmuSharedMemoryFixture(): Buffer {
  const memory = Buffer.alloc(LMU_SHARED_MEMORY_SIZE);
  memory.writeInt32LE(1202, LMU_GAME_VERSION_OFFSET);
  memory.writeUInt32LE(9, LMU_SESSION_EVENT_OFFSET);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET);
  memory.writeUInt8(0, LMU_TELEMETRY_HEADER_OFFSET + 1);
  memory.writeUInt8(1, LMU_TELEMETRY_HEADER_OFFSET + 2);

  const telemetry = LMU_TELEMETRY_INFO_OFFSET;
  memory.writeInt32LE(42, telemetry + LMU_TELEMETRY.id);
  memory.writeDoubleLE(321.5, telemetry + LMU_TELEMETRY.elapsedTime);
  memory.writeInt32LE(3, telemetry + LMU_TELEMETRY.lapNumber);
  memory.writeDoubleLE(300, telemetry + LMU_TELEMETRY.lapStartElapsedTime);
  writeCString(memory, telemetry + LMU_TELEMETRY.vehicleName, 64, "Ferrari 499P #50");
  writeCString(memory, telemetry + LMU_TELEMETRY.trackName, 64, "Circuit de la Sarthe");
  writeCString(memory, telemetry + LMU_TELEMETRY.vehicleModel, 30, "Ferrari 499P");
  memory.writeUInt8(0, telemetry + LMU_TELEMETRY.vehicleClass);
  memory.writeDoubleLE(12, telemetry + LMU_TELEMETRY.position);
  memory.writeDoubleLE(3, telemetry + LMU_TELEMETRY.position + 8);
  memory.writeDoubleLE(45, telemetry + LMU_TELEMETRY.position + 16);
  memory.writeDoubleLE(-70, telemetry + LMU_TELEMETRY.localVelocity + 16);
  memory.writeDoubleLE(2, telemetry + LMU_TELEMETRY.localAcceleration);
  memory.writeDoubleLE(-4, telemetry + LMU_TELEMETRY.localAcceleration + 16);
  memory.writeDoubleLE(1, telemetry + LMU_TELEMETRY.orientation);
  memory.writeDoubleLE(1, telemetry + LMU_TELEMETRY.orientation + 24 + 8);
  memory.writeDoubleLE(-1, telemetry + LMU_TELEMETRY.orientation + 48 + 16);
  memory.writeInt32LE(4, telemetry + LMU_TELEMETRY.gear);
  memory.writeDoubleLE(8_000, telemetry + LMU_TELEMETRY.engineRpm);
  memory.writeDoubleLE(10_500, telemetry + LMU_TELEMETRY.engineMaxRpm);
  memory.writeDoubleLE(0.75, telemetry + LMU_TELEMETRY.throttle);
  memory.writeDoubleLE(0.2, telemetry + LMU_TELEMETRY.brake);
  memory.writeDoubleLE(-0.3, telemetry + LMU_TELEMETRY.steering);
  memory.writeDoubleLE(0.1, telemetry + LMU_TELEMETRY.clutch);
  memory.writeDoubleLE(42, telemetry + LMU_TELEMETRY.fuel);
  memory.writeDoubleLE(90, telemetry + LMU_TELEMETRY.fuelCapacity);
  memory.writeInt32LE(1, telemetry + LMU_TELEMETRY.currentSector);
  memory.writeUInt8(1, telemetry + LMU_TELEMETRY.rearFlapActivated);
  memory.writeUInt8(1, telemetry + LMU_TELEMETRY.tcActive);
  memory.writeUInt8(5, telemetry + LMU_TELEMETRY.tc);
  memory.writeUInt8(2, telemetry + LMU_TELEMETRY.abs);
  memory.writeFloatLE(72, telemetry + LMU_TELEMETRY.stateOfCharge);
  memory.writeFloatLE(63, telemetry + LMU_TELEMETRY.virtualEnergy);
  memory.writeFloatLE(-80, telemetry + LMU_TELEMETRY.regenKw);

  for (let index = 0; index < 4; index++) {
    const wheel = telemetry + LMU_TELEMETRY.wheels + index * LMU_WHEEL_SIZE;
    memory.writeDoubleLE(0.04 + index * 0.001, wheel + LMU_WHEEL.suspensionDeflection);
    memory.writeDoubleLE(500 + index * 10, wheel + LMU_WHEEL.brakeTemperature);
    memory.writeDoubleLE(210 + index, wheel + LMU_WHEEL.rotation);
    memory.writeDoubleLE(1 + index, wheel + LMU_WHEEL.longitudinalPatchVelocity);
    memory.writeDoubleLE(70, wheel + LMU_WHEEL.longitudinalGroundVelocity);
    memory.writeDoubleLE(0.7, wheel + LMU_WHEEL.lateralPatchVelocity);
    memory.writeDoubleLE(180 + index, wheel + LMU_WHEEL.pressureKpa);
    memory.writeDoubleLE(363.15 + index, wheel + LMU_WHEEL.temperature);
    memory.writeDoubleLE(365.15 + index, wheel + LMU_WHEEL.temperature + 8);
    memory.writeDoubleLE(367.15 + index, wheel + LMU_WHEEL.temperature + 16);
    memory.writeDoubleLE(0.1 + index * 0.01, wheel + LMU_WHEEL.wear);
    memory.writeDoubleLE(360.15 + index, wheel + LMU_WHEEL.tireCarcassTemperature);
  }

  memory.writeDoubleLE(13_626, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.lapDistance);
  memory.writeInt32LE(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
  memory.writeUInt8(1, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime);
  memory.writeDoubleLE(24, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.ambientTemperature);
  memory.writeInt32LE(10, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session);
  memory.writeDoubleLE(31, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackTemperature);
  writeCString(memory, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName, 64, "Circuit de la Sarthe");
  writeCString(memory, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.playerName, 32, "Test Driver");

  const scoring = LMU_SCORING_VEHICLES_OFFSET;
  memory.writeInt32LE(42, scoring + LMU_SCORING_VEHICLE.id);
  writeCString(memory, scoring + LMU_SCORING_VEHICLE.driverName, 32, "Test Driver");
  writeCString(memory, scoring + LMU_SCORING_VEHICLE.vehicleName, 64, "Ferrari 499P #50");
  memory.writeInt16LE(2, scoring + LMU_SCORING_VEHICLE.totalLaps);
  memory.writeDoubleLE(5_000, scoring + LMU_SCORING_VEHICLE.lapDistance);
  memory.writeDoubleLE(230.5, scoring + LMU_SCORING_VEHICLE.bestLapTime);
  memory.writeDoubleLE(232.25, scoring + LMU_SCORING_VEHICLE.lastLapTime);
  memory.writeUInt8(1, scoring + LMU_SCORING_VEHICLE.isPlayer);
  memory.writeUInt8(2, scoring + LMU_SCORING_VEHICLE.place);
  memory.writeUInt8(0, scoring + LMU_SCORING_VEHICLE.inPits);
  expect(scoring + LMU_SCORING_VEHICLE_SIZE).toBeLessThan(LMU_TELEMETRY_INFO_OFFSET);
  return memory;
}





describe("LMU adapter", () => {
  test("resolves only collision-safe native catalog aliases", () => {
    expect(resolveLMUCar("Ferrari 499P")?.id).toBe("ferrari_499p_2023");
    expect(resolveLMUCar("ferrari_499p_2023/50_24_afco15a3d85a")?.id).toBe(
      "ferrari_499p_2023",
    );
    expect(resolveLMUCar("50_24_afco15a3d85a")?.id).toBe(
      "ferrari_499p_2023",
    );
    expect(resolveLMUCar("Peugeot 9x8")).toBeUndefined();
    expect(resolveLMUCar("Oreca 07")).toBeUndefined();
    expect(resolveLMUTrack("LeMansWEC")?.id).toBe(
      "lemans_2023/lemanswec",
    );
    expect(resolveLMUTrack("Circuit de la Sarthe")?.id).toBe(
      "lemans_2023/lemanswec",
    );
    expect(resolveLMUTrack("Circuit de Spa-Francorchamps")).toBeUndefined();
    expect(
      resolveLMUTrack("Circuit de Spa-Francorchamps", "SpaWEC")?.id,
    ).toBe("spa_2023/spawec");
    expect(
      resolveLMUTrack("SpaWEC", "PortimaoWEC"),
    ).toBeUndefined();
  });


  test("inherits shared facts and compatible geometry for catalog tracks", () => {
    const segments = loadLabelledSegments("spa", "lmu");
    const compatibleSegments = loadLabelledSegments("spa", "acc");
    for (const name of ["La Source", "Kemmel"]) {
      expect(segments.find((segment) => segment.name === name)).toEqual(
        compatibleSegments.find((segment) => segment.name === name),
      );
    }
  });

  test("encodes installed shared-memory layout and normalizes player telemetry", () => {
    const rawFrame = encodeLMUSourceFrame(lmuSharedMemoryFixture(), 1_800_000_000_000);
    expect(rawFrame).not.toBeNull();
    expect(rawFrame!.length).toBeGreaterThan(LMU_SHARED_MEMORY_SIZE);
    expect(canHandleLMUSourceFrame(rawFrame!)).toBe(true);
    const decoded = decodeLMUSourceFrame(rawFrame!);
    expect(decoded?.schemaVersion).toBe(2);
    expect(decoded?.rawSharedMemory).toEqual(lmuSharedMemoryFixture());
    expect(decoded?.sessionEvent).toBe(9);

    const packet = lmuServerAdapter.tryParse(rawFrame!, null);
    expect(packet).not.toBeNull();
    expect(packet).toMatchObject({
      gameId: "lmu",
      IsRaceOn: 1,
      LapNumber: 4,
      RacePosition: 2,
      CurrentEngineRpm: 8_000,
      Gear: 4,
      Accel: 191,
      Brake: 51,
      TrackTemp: 31,
      AirTemp: 24,
      CarOrdinal: -1,
      TrackOrdinal: -1,
    });
    expect(packet).toMatchObject({
      TireTempFL: 92,
      TireSurfaceTempInnerFL: 94,
      TireSurfaceTempMiddleFL: 92,
      TireSurfaceTempOuterFL: 90,
      TireSurfaceTempInnerFR: 91,
      TireSurfaceTempMiddleFR: 93,
      TireSurfaceTempOuterFR: 95,
      TireCarcassAverageTempFL: 87,
    });
    expect(packet!.TireCarcassTempLeftFL).toBeUndefined();
    expect(packet!.TireCarcassTempFL).toBeUndefined();
    const semanticIds = ["tire.temperature.surface.inner", "tire.temperature.surface.middle", "tire.temperature.surface.outer", "tire.temperature.carcass.representative", "tire.temperature.core"];
    const resolver = compileTelemetryResolver(TELEMETRY_CATALOG, { simulator: "lmu", requested: semanticIds.map((semanticId) => ({ semanticId })) });
    const semanticFrame = resolver.createFrameView(packet!, { timestamp: { domain: "session", milliseconds: 1_000 }, updateSequence: 1n });
    expect(semanticFrame.resolveValue<readonly number[]>(resolver.slot(semanticIds[0]!))).toMatchObject({ value: [94, 91, 96, 93], state: "ok" });
    expect(semanticFrame.resolveValue<readonly number[]>(resolver.slot(semanticIds[1]!))).toMatchObject({ value: [92, 93, 94, 95], state: "ok" });
    expect(semanticFrame.resolveValue<readonly number[]>(resolver.slot(semanticIds[2]!))).toMatchObject({ value: [90, 95, 92, 97], state: "ok" });
    expect(semanticFrame.resolveValue<readonly number[]>(resolver.slot(semanticIds[3]!))).toMatchObject({ value: [87, 88, 89, 90], state: "ok" });
    expect(semanticFrame.resolveValue(resolver.slot(semanticIds[4]!)).state).toBe("missing");
    expect(packet!.TireSlipAngleFL).toBeCloseTo(Math.atan2(0.7, 70), 12);
    expect(packet!.TireSlipRatioFL).toBeCloseTo(1 / 70, 12);
    expect(packet!.TireCombinedSlipFL).toBeCloseTo(
      Math.hypot(1 / 70, 0.7 / 70),
      12,
    );
    expect(packet!.Speed).toBeCloseTo(70, 5);
    expect(packet!.DistanceTraveled).toBeCloseTo(32_252, 3);
    expect(packet!.lmu).toMatchObject({
      carId: "ferrari_499p_2023",
      trackId: "lemans_2023/lemanswec",
      driverName: "Test Driver",
      sessionType: "race",
      sessionTypeOrdinal: 10,
      carName: "Ferrari 499P #50",
      carModel: "Ferrari 499P",
      trackName: "Circuit de la Sarthe",
      trackLengthM: 13_626,
      lapDistanceM: 5_000,
      tcActive: true,
      tcLevel: 5,
      absLevel: 2,
      rearFlapActivated: true,
    });
  });

  test("propagates game's lap-invalidated flag into lap validity", () => {
    const memory = lmuSharedMemoryFixture();
    memory.writeUInt8(
      1,
      LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.lapInvalidated,
    );
    const packet = lmuServerAdapter.tryParse(
      encodeLMUSourceFrame(memory, 1_800_000_000_000)!,
      null,
    );

    expect(packet?.lmu?.lapInvalidated).toBe(true);
    expect(resolveLMUInvalidReason([packet!])).toBe("game-invalidated");
  });

  test("preserves clean lap-invalidated flag without inventing an exclusion", () => {
    const packet = lmuServerAdapter.tryParse(
      encodeLMUSourceFrame(lmuSharedMemoryFixture(), 1_800_000_000_000)!,
      null,
    );
    expect(packet?.lmu?.lapInvalidated).toBe(false);
    expect(resolveLMUInvalidReason([packet!])).toBeNull();
  });

  test("records lap boundaries from low-rate live LMU frames", async () => {
    const db = new CapturingDbAdapter();
    const detector = lmuServerAdapter.createLapDetector({ db });
    const firstMemory = lmuSharedMemoryFixture();
    const nextMemory = Buffer.from(firstMemory);
    nextMemory.writeInt32LE(
      4,
      LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.lapNumber,
    );
    nextMemory.writeInt16LE(
      3,
      LMU_SCORING_VEHICLES_OFFSET + LMU_SCORING_VEHICLE.totalLaps,
    );

    const first = lmuServerAdapter.tryParse(
      encodeLMUSourceFrame(firstMemory, 1_800_000_000_000)!,
      null,
    );
    const next = lmuServerAdapter.tryParse(
      encodeLMUSourceFrame(nextMemory, 1_800_000_001_000)!,
      null,
    );
    expect(first).not.toBeNull();
    expect(next).not.toBeNull();

    await detector.feed(first!);
    await detector.feed(next!);
    expect(db.sessions[0]?.sessionType).toBe("race");

    expect(db.laps).toHaveLength(1);
    expect(db.laps[0]).toMatchObject({
      lapNumber: 4,
      lapTime: 232.25,
    });
  });

  test("polls only changed snapshots and records replayable source frames", async () => {
    const snapshot = lmuSharedMemoryFixture();
    const delivered: Buffer[] = [];
    const reader = {
      start() {},
      async stop() {},
      readLatest: () => snapshot,
    };
    const source = new LMUTelemetrySource({
      reader,
      dispatchRawFrame: async (frame) => {
        delivered.push(Buffer.from(frame));
      },
    });
    expect(await source.pollOnce()).toBe(true);
    expect(await source.pollOnce()).toBe(false);
    expect(delivered).toHaveLength(1);

    const directory = temporaryDirectory();
    const recorder = new LMURecorder();
    const path = recorder.start(directory);
    recorder.writeFrame(delivered[0]!);
    await recorder.stop();
    expect(readLMUFrames(path)).toEqual(delivered);
  });

  test("queues changed snapshots FIFO and drains before recorder finalization", async () => {
    const snapshots = [321.5, 322.5, 322.5, 323.5].map((elapsedTime) => {
      const snapshot = lmuSharedMemoryFixture();
      snapshot.writeDoubleLE(elapsedTime, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
      return snapshot;
    });
    let reads = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const dispatched: number[] = [];
    const recorded: number[] = [];
    const capturedTimes: number[] = [];
    let recorderStopped = false;
    let readerStopped = false;
    const source = new LMUTelemetrySource({
      reader: {
        start() {},
        async stop() { readerStopped = true; },
        readLatest() { reads++; return snapshots.shift() ?? null; },
      },
      recordingEnabled: true,
      recorder: {
        recording: true,
        start: () => "",
        writeFrame(frame) {
          recorded.push(decodeLMUSourceFrame(frame)!.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime));
        },
        async stop() { recorderStopped = true; },
      },
      async dispatchRawFrame(frame, frameTimeMs) {
        const elapsedTime = decodeLMUSourceFrame(frame)!.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime);
        dispatched.push(elapsedTime);
        capturedTimes.push(frameTimeMs!);
        if (elapsedTime === 321.5) await firstBlocked;
        if (elapsedTime === 322.5) throw new Error("expected downstream failure");
      },
    });

    const results = [source.pollOnce(), source.pollOnce(), source.pollOnce(), source.pollOnce()];
    expect(reads).toBe(4);
    expect(await results[2]).toBe(false);
    const stopped = source.stop();
    expect(readerStopped).toBe(true);
    expect(recorderStopped).toBe(false);
    const beforeRelease = Date.now();
    await Bun.sleep(10);
    releaseFirst();
    expect(await Promise.all(results)).toEqual([true, false, false, true]);
    await stopped;
    expect(recorded).toEqual([321.5, 322.5, 323.5]);
    expect(dispatched).toEqual([321.5, 322.5, 323.5]);
    expect(capturedTimes).toHaveLength(3);
    expect(capturedTimes[1]).toBeLessThanOrEqual(beforeRelease);
    expect(capturedTimes[2]).toBeLessThanOrEqual(beforeRelease);
    expect(recorderStopped).toBe(true);
  });

  test("reads LMU DuckDB uploads into canonical source frames", async () => {
    const path = join(temporaryDirectory(), "session.duckdb");
    await createLMUDuckDB(path);
    const preview = await previewLMUDuckDB(path);
    expect(preview).toMatchObject({
      gameId: "lmu",
      driverName: "Test Driver",
      carName: "Ferrari 499P #50",
      trackName: "Circuit de la Sarthe",
      completedLapCount: 2,
      estimatedPacketCount: 1_501,
    });

    let firstPacket = null;
    let secondLapPacket = null;
    let finalPacket = null;
    let frameCount = 0;
    for await (const frame of readLMUDuckDBFrames(path)) {
      const packet = lmuServerAdapter.tryParse(frame, null);
      firstPacket ??= packet;
      if (packet?.LapNumber === 2) secondLapPacket = packet;
      finalPacket = packet;
      frameCount++;
    }
    expect(frameCount).toBe(1_501);
    expect(firstPacket).toMatchObject({
      gameId: "lmu",
      IsRaceOn: 1,
      LapNumber: 1,
      Speed: 50,
      SuspensionTravelMFL: 0.05,
      CarOrdinal: -1,
      TrackOrdinal: -1,
      lmu: {
        carId: "ferrari_499p_2023",
        trackId: "lemans_2023/lemanswec",
      },
    });
    expect(secondLapPacket).toMatchObject({
      LapNumber: 2,
      LastLap: 15,
      lmu: {
        driverName: "Test Driver",
        carModel: "Ferrari 499P",
        trackName: "Circuit de la Sarthe",
      },
    });
    expect(finalPacket).toMatchObject({
      LapNumber: 3,
      LastLap: 15,
    });
  }, 60_000);

  

  

  
});
