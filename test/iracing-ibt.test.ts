import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IRacingIbtReader } from "../server/games/iracing/ibt-reader";
import {
  commitStagedIbt,
  previewIbtFile,
  stageIbtUpload,
} from "../server/import-ibt";
import { normalizeIRacingFrame } from "../server/games/iracing/normalizer";
import { IRacingTelemetrySource } from "../server/games/iracing/source";
import { deleteSession, getLapsRaw } from "../server/db/queries";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
} from "../server/games/iracing/source-frame";
import {
  IRSDK_VAR_HEADER_SIZE,
  IRSDKVariableType,
} from "../server/games/iracing/variable-table";

const DISK_HEADER_SIZE = 144;
const ROW_LENGTH = 40;

initGameAdapters();
initServerGameAdapters();

interface SyntheticRow {
  sessionTime: number;
  sessionTick: number;
  speed: number;
  lapDistancePct: number;
  lap?: number;
  lastLapTime?: number;
  currentLapTime?: number;
}

function writeCString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length - 1);
}

function descriptor(
  type: IRSDKVariableType,
  valueOffset: number,
  name: string,
): Buffer {
  const buffer = Buffer.alloc(IRSDK_VAR_HEADER_SIZE);
  buffer.writeInt32LE(type, 0);
  buffer.writeInt32LE(valueOffset, 4);
  buffer.writeInt32LE(1, 8);
  writeCString(buffer, 16, 32, name);
  writeCString(buffer, 48, 64, `${name} description`);
  return buffer;
}

function telemetryRow(row: SyntheticRow): Buffer {
  const buffer = Buffer.alloc(ROW_LENGTH);
  buffer.writeDoubleLE(row.sessionTime, 0);
  buffer.writeInt32LE(row.sessionTick, 8);
  buffer.writeInt32LE(2, 12);
  buffer.writeUInt8(1, 16);
  buffer.writeUInt8(0, 17);
  buffer.writeFloatLE(row.speed, 20);
  buffer.writeInt32LE(row.lap ?? 3, 24);
  buffer.writeFloatLE(row.lapDistancePct, 28);
  buffer.writeFloatLE(row.lastLapTime ?? 0, 32);
  buffer.writeFloatLE(row.currentLapTime ?? row.sessionTime, 36);
  return buffer;
}

function writeSyntheticIbt(
  path: string,
  suppliedRows?: SyntheticRow[],
): void {
  const variableHeaders = Buffer.concat([
    descriptor(IRSDKVariableType.Double, 0, "SessionTime"),
    descriptor(IRSDKVariableType.Int, 8, "SessionTick"),
    descriptor(IRSDKVariableType.Int, 12, "SessionNum"),
    descriptor(IRSDKVariableType.Bool, 16, "IsOnTrack"),
    descriptor(IRSDKVariableType.Bool, 17, "OnPitRoad"),
    descriptor(IRSDKVariableType.Float, 20, "Speed"),
    descriptor(IRSDKVariableType.Int, 24, "Lap"),
    descriptor(IRSDKVariableType.Float, 28, "LapDistPct"),
    descriptor(IRSDKVariableType.Float, 32, "LapLastLapTime"),
    descriptor(IRSDKVariableType.Float, 36, "LapCurrentLapTime"),
  ]);
  const sessionInfo = Buffer.from(`
WeekendInfo:
  TrackID: 99
  TrackLength: 6.515 km
  TrackDisplayName: Road America
  SessionID: 123
  SubSessionID: 456
SplitTimeInfo:
  Sectors:
  - SectorNum: 0
    SectorStartPct: 0.000000
  - SectorNum: 1
    SectorStartPct: 0.500000
  DriverInfo:
  DriverCarIdx: 7
  DriverCarIdleRPM: 900
  DriverCarRedLine: 8500
  DriverCarEngCylinderCount: 8
  Drivers:
  - CarIdx: 7
    CarID: 42
    CarScreenName: GT3 Test Car
    CarClassID: 8
    CarClassShortName: GT3
\0`);
  const sourceRows: SyntheticRow[] = suppliedRows ?? [
    {
      sessionTime: 10,
      sessionTick: 600,
      speed: 50.5,
      lapDistancePct: 0.25,
    },
    {
      sessionTime: 10 + 1 / 60,
      sessionTick: 601,
      speed: 51.5,
      lapDistancePct: 0.26,
    },
  ];
  const rows = sourceRows.map(telemetryRow);

  const sessionInfoOffset =
    DISK_HEADER_SIZE + variableHeaders.length;
  const header = Buffer.alloc(DISK_HEADER_SIZE);
  header.writeInt32LE(2, 0);
  header.writeInt32LE(1, 4);
  header.writeInt32LE(60, 8);
  header.writeInt32LE(sessionInfo.length, 16);
  header.writeInt32LE(sessionInfoOffset, 20);
  header.writeInt32LE(
    variableHeaders.length / IRSDK_VAR_HEADER_SIZE,
    24,
  );
  header.writeInt32LE(DISK_HEADER_SIZE, 28);
  header.writeInt32LE(1, 32);
  header.writeInt32LE(ROW_LENGTH, 36);
  header.writeBigInt64LE(1_757_390_931n, 112);
  header.writeDoubleLE(sourceRows[0]?.sessionTime ?? 0, 120);
  header.writeDoubleLE(
    sourceRows[sourceRows.length - 1]?.sessionTime ?? 0,
    128,
  );
  header.writeInt32LE(1, 136);
  header.writeInt32LE(rows.length, 140);

  writeFileSync(
    path,
    Buffer.concat([
      header,
      variableHeaders,
      sessionInfo,
      ...rows,
    ]),
  );
}

function drivenRows(): SyntheticRow[] {
  return [
    {
      sessionTime: 0,
      sessionTick: 0,
      speed: 45,
      lap: 1,
      lapDistancePct: 0.2,
      currentLapTime: 10,
    },
    {
      sessionTime: 45,
      sessionTick: 2700,
      speed: 48,
      lap: 1,
      lapDistancePct: 0.9,
      currentLapTime: 55,
    },
    {
      sessionTime: 50,
      sessionTick: 3000,
      speed: 44,
      lap: 2,
      lapDistancePct: 0.1,
      lastLapTime: 60,
      currentLapTime: 5,
    },
    {
      sessionTime: 105,
      sessionTick: 6300,
      speed: 47,
      lap: 2,
      lapDistancePct: 0.9,
      lastLapTime: 60,
      currentLapTime: 55,
    },
    {
      sessionTime: 110,
      sessionTick: 6600,
      speed: 46,
      lap: 3,
      lapDistancePct: 0.1,
      lastLapTime: 60,
      currentLapTime: 5,
    },
    {
      sessionTime: 112,
      sessionTick: 6720,
      speed: 46,
      lap: 3,
      lapDistancePct: 0.14,
      lastLapTime: 61,
      currentLapTime: 2,
    },
  ];
}

describe("IRacingIbtReader", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  function createRecording(): string {
    tempDir = mkdtempSync(join(tmpdir(), "raceiq-ibt-"));
    const path = join(tempDir, "sample.ibt");
    writeSyntheticIbt(path);
    return path;
  }

  test("streams SDK-compatible snapshots and exposes disk metadata", async () => {
    const path = createRecording();
    const reader = new IRacingIbtReader(path);

    expect(reader.readLatest()).toBeNull();
    reader.start();
    reader.start();

    expect(reader.metadata).toMatchObject({
      version: 2,
      status: 1,
      tickRate: 60,
      lapCount: 1,
      recordCount: 2,
      rowLength: ROW_LENGTH,
      trailingBytes: 0,
    });
    expect(reader.metadata?.sessionStartDate.toISOString()).toBe(
      "2025-09-09T04:08:51.000Z",
    );
    expect(reader.metadata?.missingRaceIQVariables).not.toContain(
      "Speed",
    );
    expect(reader.metadata?.missingRaceIQVariables).toContain(
      "LFshockDefl",
    );

    const first = reader.readLatest();
    expect(first).not.toBeNull();
    expect(first?.tick).toBe(600);
    expect(first?.values).toMatchObject({
      SessionTime: 10,
      SessionTick: 600,
      SessionNum: 2,
      IsOnTrack: true,
      OnPitRoad: false,
      Speed: 50.5,
      Lap: 3,
    });
    expect(reader.recordsRead).toBe(1);
    expect(reader.done).toBe(false);

    const second = reader.readLatest();
    expect(second?.tick).toBe(601);
    expect(second?.values.Speed).toBeCloseTo(51.5);
    expect(reader.recordsRead).toBe(2);
    expect(reader.done).toBe(true);
    expect(reader.readLatest()).toBeNull();

    await reader.stop();
    await reader.stop();
    expect(reader.readLatest()).toBeNull();
  });

  test("reuses the existing source-frame and normalizer path", async () => {
    const reader = new IRacingIbtReader(createRecording());
    const delivered: Buffer[] = [];
    reader.start();
    const source = new IRacingTelemetrySource({
      reader,
      dispatchRawFrame: async (raw) => {
        delivered.push(raw);
      },
    });

    expect(await source.pollOnce()).toBe(true);
    expect(await source.pollOnce()).toBe(true);
    expect(await source.pollOnce()).toBe(false);
    expect(delivered).toHaveLength(2);

    const decoder = createIRacingSourceDecoderState();
    const frame = decodeIRacingSourceFrame(delivered[0], decoder);
    expect(frame?.session).toMatchObject({
      sessionId: 123,
      subSessionId: 456,
      sessionNum: 2,
      trackId: 99,
      trackName: "Road America",
      carId: 42,
      carName: "GT3 Test Car",
    });
    expect(frame).not.toBeNull();
    const packet = normalizeIRacingFrame(frame!);
    expect(packet.gameId).toBe("iracing");
    expect(packet.sessionUID).toBe("456:123:2");
    expect(packet.Speed).toBeCloseTo(50.5);
    expect(packet.LapNumber).toBe(3);
    expect(packet.iracing?.lapDistancePct).toBeCloseTo(0.25);

    const secondFrame = decodeIRacingSourceFrame(delivered[1], decoder);
    expect(secondFrame?.values.Speed).toBeCloseTo(51.5);

    await source.stop();
  });

  test("rejects a recording whose declared rows are truncated", () => {
    const path = createRecording();
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 1));

    const reader = new IRacingIbtReader(path);
    expect(() => reader.start()).toThrow(
      "Truncated iRacing IBT",
    );
    expect(reader.metadata).toBeNull();
    expect(reader.readLatest()).toBeNull();
  });

  test("previews a driven recording without writing it to the database", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "raceiq-ibt-"));
    const path = join(tempDir, "driven.ibt");
    writeSyntheticIbt(path, drivenRows());

    const preview = await previewIbtFile(path);
    expect(preview).toMatchObject({
      gameId: "iracing",
      trackName: "Road America",
      carName: "GT3 Test Car",
      drivingFrames: 6,
      lapTransitions: 2,
      candidateLapCount: 1,
      canImport: true,
      reason: null,
    });
    expect(preview.maxSpeedMph).toBeGreaterThan(100);
  });

  test("commits a staged IBT through the normal pipeline and canonical recorder", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "raceiq-ibt-"));
    const path = join(tempDir, "driven.ibt");
    writeSyntheticIbt(path, drivenRows());
    const bytes = readFileSync(path);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    let sessionId: number | null = null;
    let rawFile: string | null = null;
    try {
      const staged = await stageIbtUpload(
        body,
        "driven.ibt",
        bytes.byteLength,
      );
      expect(staged.token).not.toBeNull();
      expect(staged.preview.candidateLapCount).toBe(1);

      const imported = await commitStagedIbt(staged.token!);
      expect(imported.packetCount).toBe(6);
      expect(imported.laps).toHaveLength(1);
      expect(imported.laps[0]).toMatchObject({
        lapNumber: 2,
      });

      sessionId = imported.laps[0].sessionId;
      const [stored] = await getLapsRaw([imported.laps[0].lapId]);
      rawFile = stored?.rawFile ?? null;
      expect(rawFile).toEndWith(".bin");
      expect(rawFile ? existsSync(rawFile) : false).toBe(true);
    } finally {
      if (sessionId !== null) await deleteSession(sessionId);
      if (rawFile) rmSync(rawFile, { force: true });
    }
  });

  test("rejects an IBT preview containing only an initial partial lap", async () => {
    const preview = await previewIbtFile(createRecording());

    expect(preview.canImport).toBe(false);
    expect(preview.candidateLapCount).toBe(0);
    expect(preview.reason).toContain("No complete laps");
  });
});
