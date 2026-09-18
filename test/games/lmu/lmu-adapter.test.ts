import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  lmuAdapter,
  lmuIdentityOrdinal,
} from "../../../shared/games/lmu";
import { lmuServerAdapter } from "../../../server/games/lmu";
import { transferRoutes } from "../../../server/routes/laps/transfer-routes";
import {
  previewLMUDuckDB,
  readLMUDuckDBFrames,
} from "../../../server/games/lmu/import-duckdb";
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
} from "../../../server/games/lmu/layout";
import {
  LMURecorder,
  readLMUFrames,
} from "../../../server/games/lmu/recorder";
import { LMUTelemetrySource } from "../../../server/games/lmu/source";
import {
  canHandleLMUSourceFrame,
  decodeLMUSourceFrame,
  encodeLMUSourceFrame,
} from "../../../server/games/lmu/source-frame";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

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
    memory.writeDoubleLE(71 + index, wheel + LMU_WHEEL.longitudinalPatchVelocity);
    memory.writeDoubleLE(70, wheel + LMU_WHEEL.longitudinalGroundVelocity);
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

async function populateLMUDuckDB(
  connection: DuckDBConnection,
  lapRows = "(0,0),(15,1),(30,2)",
  includeLapDistance = true,
): Promise<void> {
  await connection.run("CREATE TABLE metadata(key VARCHAR, value VARCHAR)");
  await connection.run(`INSERT INTO metadata VALUES
    ('Version','1'),
    ('RecordingTime','2026-08-12T18_01_09Z'),
    ('SessionType','Race'),
    ('DriverName','Test Driver'),
    ('CarName','Ferrari 499P #50'),
    ('CarClass','Hypercar'),
    ('TrackName','Circuit de la Sarthe')`);
  await connection.run("CREATE TABLE channelsList(channelName VARCHAR, frequency INTEGER, unit VARCHAR)");
  await connection.run(
    `INSERT INTO channelsList VALUES ${
      includeLapDistance ? "('Lap Dist',10,'m')," : ""
    }('Ground Speed',50,'km/h'),('Susp Pos',50,'mm')`,
  );
  await connection.run("CREATE TABLE eventsList(eventName VARCHAR, unit VARCHAR)");
  if (includeLapDistance) {
    await connection.run('CREATE TABLE "Lap Dist" AS SELECT ((range % 150) * (1000.0 / 150))::FLOAT AS value FROM range(300)');
  }
  await connection.run('CREATE TABLE "Ground Speed" AS SELECT 180::FLOAT AS value FROM range(1501)');
  await connection.run('CREATE TABLE "Susp Pos" AS SELECT 50::FLOAT AS value1, 50::FLOAT AS value2, 50::FLOAT AS value3, 50::FLOAT AS value4 FROM range(1501)');
  await connection.run('CREATE TABLE "Lap"(ts DOUBLE, value USMALLINT)');
  await connection.run(`INSERT INTO "Lap" VALUES ${lapRows}`);
  await connection.run('CREATE TABLE "Lap Time"(ts DOUBLE, value FLOAT)');
  await connection.run('INSERT INTO "Lap Time" VALUES (0,0),(15,15),(30,15)');
  await connection.run('CREATE TABLE "Best LapTime"(ts DOUBLE, value FLOAT)');
  await connection.run('INSERT INTO "Best LapTime" VALUES (0,0),(15,15)');
  await connection.run('CREATE TABLE "Engine Max RPM"(ts DOUBLE, value FLOAT)');
  await connection.run('INSERT INTO "Engine Max RPM" VALUES (0,11000)');
}

async function createLMUDuckDB(
  path: string,
  lapRows?: string,
  includeLapDistance = true,
): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  try {
    await populateLMUDuckDB(connection, lapRows, includeLapDistance);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

describe("LMU adapter", () => {
  test("encodes installed shared-memory layout and normalizes player telemetry", () => {
    const rawFrame = encodeLMUSourceFrame(lmuSharedMemoryFixture(), 1_800_000_000_000);
    expect(rawFrame).not.toBeNull();
    expect(canHandleLMUSourceFrame(rawFrame!)).toBe(true);
    const decoded = decodeLMUSourceFrame(rawFrame!);
    expect(decoded?.gameVersion).toBe(1202);
    expect(decoded?.sessionEvent).toBe(9);

    const packet = lmuServerAdapter.tryParse(rawFrame!, null);
    expect(packet).not.toBeNull();
    expect(packet).toMatchObject({
      gameId: "lmu",
      IsRaceOn: 1,
      LapNumber: 3,
      RacePosition: 2,
      CurrentEngineRpm: 8_000,
      Gear: 4,
      Accel: 191,
      Brake: 51,
      TrackTemp: 31,
      AirTemp: 24,
    });
    expect(packet!.Speed).toBeCloseTo(70, 5);
    expect(packet!.DistanceTraveled).toBeCloseTo(32_252, 3);
    expect(packet!.TireTempFL).toBeCloseTo(92, 5);
    expect(packet!.TirePressureFrontLeft).toBeCloseTo(26.1068, 3);
    expect(packet!.lmu).toMatchObject({
      driverName: "Test Driver",
      carModel: "Ferrari 499P",
      trackName: "Circuit de la Sarthe",
      trackLengthM: 13_626,
      lapDistanceM: 5_000,
      tcActive: true,
      tcLevel: 5,
      absLevel: 2,
      rearFlapActivated: true,
    });
    expect(lmuAdapter.getCarName(packet!.CarOrdinal)).toBe("LMU car #" + packet!.CarOrdinal);
  });

  test("polls only changed snapshots and records replayable source frames", async () => {
    const snapshot = lmuSharedMemoryFixture();
    const delivered: Buffer[] = [];
    const identities: string[] = [];
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
      registerIdentity: async (identity) => {
        identities.push(`${identity.carName}|${identity.trackName}`);
      },
    });
    expect(await source.pollOnce()).toBe(true);
    expect(await source.pollOnce()).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(identities).toEqual(["Ferrari 499P|Circuit de la Sarthe"]);

    const directory = temporaryDirectory();
    const recorder = new LMURecorder();
    const path = recorder.start(directory);
    recorder.writeFrame(delivered[0]!);
    await recorder.stop();
    expect(readLMUFrames(path)).toEqual(delivered);
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
      if (packet?.LapNumber === 1) secondLapPacket = packet;
      finalPacket = packet;
      frameCount++;
    }
    expect(frameCount).toBe(1_501);
    expect(firstPacket).toMatchObject({
      gameId: "lmu",
      IsRaceOn: 1,
      LapNumber: 0,
      Speed: 50,
      SuspensionTravelMFL: 0.05,
      CarOrdinal: lmuIdentityOrdinal("car", "Ferrari 499P"),
    });
    expect(secondLapPacket).toMatchObject({
      LapNumber: 1,
      LastLap: 15,
      lmu: {
        driverName: "Test Driver",
        carModel: "Ferrari 499P",
        trackName: "Circuit de la Sarthe",
      },
    });
    expect(finalPacket).toMatchObject({
      LapNumber: 2,
      LastLap: 15,
    });
  }, 60_000);

  test("rejects zero-lap recordings during detection", async () => {
    const path = join(temporaryDirectory(), "outlap.duckdb");
    await createLMUDuckDB(path, "(0,0)");
    const form = new FormData();
    form.append(
      "file",
      new File([readFileSync(path)], "outlap.duckdb"),
    );

    const response = await transferRoutes.request("/api/laps/detect-import", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      format: "duckdb",
      supported: false,
      message: "Recording contains no complete laps to import.",
      preview: { completedLapCount: 0 },
    });
  });

  test("rejects recordings without lap-distance telemetry during detection", async () => {
    const path = join(temporaryDirectory(), "missing-lap-distance.duckdb");
    await createLMUDuckDB(path, undefined, false);
    const form = new FormData();
    form.append(
      "file",
      new File([readFileSync(path)], "missing-lap-distance.duckdb"),
    );

    const response = await transferRoutes.request("/api/laps/detect-import", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      format: "duckdb",
      supported: false,
      message: "LMU telemetry recording contains no drivable samples",
    });
  });

  test("accepts WAL-backed recordings when matching sidecar is uploaded", async () => {
    const path = join(temporaryDirectory(), "pending.duckdb");
    const bootstrap = await DuckDBInstance.create(path);
    bootstrap.closeSync();

    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();
    try {
      await connection.run("PRAGMA disable_checkpoint_on_shutdown");
      await populateLMUDuckDB(connection);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const walPath = `${path}.wal`;
    expect(existsSync(walPath)).toBe(true);
    const databaseBytes = readFileSync(path);

    const missingWalForm = new FormData();
    missingWalForm.append(
      "file",
      new File([databaseBytes], "pending.duckdb"),
    );
    const missingWalResponse = await transferRoutes.request(
      "/api/laps/detect-import",
      { method: "POST", body: missingWalForm },
    );
    expect(await missingWalResponse.json()).toMatchObject({
      supported: false,
      message:
        'Recording requires its matching "pending.duckdb.wal" sidecar. Select both files together.',
    });

    const completeForm = new FormData();
    completeForm.append(
      "file",
      new File([databaseBytes], "pending.duckdb"),
    );
    completeForm.append(
      "wal",
      new File([readFileSync(walPath)], "pending.duckdb.wal"),
    );
    const completeResponse = await transferRoutes.request(
      "/api/laps/detect-import",
      { method: "POST", body: completeForm },
    );
    expect(await completeResponse.json()).toMatchObject({
      format: "duckdb",
      supported: true,
      preview: { completedLapCount: 2 },
    });
  });
});
