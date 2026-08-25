import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test, expect, spyOn } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { RealDbAdapter, CapturingDbAdapter, NullWsAdapter, type SessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";
import * as DriverProfileRunner from "../../server/driver-profile/runner";
import type { PersistLapInput } from "../../server/db/lap-mutation-queries";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { qualityPackets } from "../support/lap-analysis/quality-model";
import type { ArchiveVerification } from "../../shared/racing/quality/contracts";
import { sha256ContentHash } from "../../server/session-capture/identity";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";

initGameAdapters();
initServerGameAdapters();
afterAll(() => stopMaintenanceTasks());

function lapInput(sessionId: number, lapNumber: number, lapTime: number, overrides: Partial<PersistLapInput> = {}): PersistLapInput {
  return {
    sessionId,
    lapNumber,
    lapTime,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 0,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    quality: null,
    eligibility: null,
    ...overrides,
  };
}

describe("CapturingDbAdapter", () => {
  test("insertSession captures data and returns incrementing IDs", async () => {
    const db = new CapturingDbAdapter();
    const id1 = await db.insertSession(100, 200, "f1-2025", "race");
    const id2 = await db.insertSession(101, 201, "acc");
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(db.sessions).toHaveLength(2);
    expect(db.sessions[0]).toMatchObject({
      carOrdinal: 100,
      trackOrdinal: 200,
      gameId: "f1-2025",
      sessionType: "race",
    });
  });

  test("insertLap captures data and returns incrementing IDs", async () => {
    const db = new CapturingDbAdapter();
    await db.insertSession(1, 1, "f1-2025");
    const id = await db.insertLap(lapInput(1, 1, 90000));
    expect(id).toBe(1);
    expect(db.laps).toHaveLength(1);
    expect(db.laps[0]).toMatchObject({
      sessionId: 1,
      lapNumber: 1,
      lapTime: 90000,
      isValid: true,
    });
  });

  test("insertLap captures sectors", async () => {
    const db = new CapturingDbAdapter();
    await db.insertSession(1, 1, "f1-2025");
    await db.insertLap(lapInput(1, 1, 90000, { sectors: [30000, 30000, 30000] }));
    expect(db.laps[0].sectors).toEqual([30000, 30000, 30000]);
  });

  test("getLaps returns empty array", async () => {
    const db = new CapturingDbAdapter();
    expect(await db.getLaps("f1-2025", 100)).toEqual([]);
  });

  test("getTuneAssignment returns null", async () => {
    const db = new CapturingDbAdapter();
    expect(await db.getTuneAssignment("f1-2025", 1, 1)).toBeNull();
  });
});

test("RealDbAdapter notifies global profile after valid and dirty persisted laps", async () => {
  const notify = spyOn(DriverProfileRunner, "notifyDriverProfileLap").mockImplementation(() => {});
  try {
    const db = new RealDbAdapter();
    const sessionId = await db.insertSession(1, 1, "f1-2025");
    await db.insertLap(lapInput(sessionId, 1, 90000));
    await db.insertLap(lapInput(sessionId, 2, 91000, { isValid: false, invalidReason: "dirty" }));
    expect(notify).toHaveBeenNthCalledWith(1, "f1-2025");
    expect(notify).toHaveBeenNthCalledWith(2, "f1-2025");
  } finally {
    notify.mockRestore();
  }
});

test("RealDbAdapter can suppress profile notifications for imports", async () => {
  const notify = spyOn(DriverProfileRunner, "notifyDriverProfileLap").mockImplementation(() => {});
  try {
    const db = new RealDbAdapter({ notifyDriverProfile: false });
    const sessionId = await db.insertSession(1, 1, "f1-2025");
    await db.insertLap(lapInput(sessionId, 1, 90000));
    expect(notify).not.toHaveBeenCalled();
  } finally {
    notify.mockRestore();
  }
});

describe("NullWsAdapter", () => {
  test("all methods are no-ops and do not throw", () => {
    const ws = new NullWsAdapter();
    expect(() => ws.broadcast({ gameId: "f1-2025" } as TelemetryPacket, null, null)).not.toThrow();
    expect(() => ws.broadcastNotification({ type: "test" })).not.toThrow();
    expect(() => ws.broadcastDevState({ key: "value" })).not.toThrow();
  });
});

class TestSessionRecorder implements SessionRecorderAdapter {
  private readonly filePath: string;
  active = false;
  epoch = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  start(): void {
    this.active = true;
    this.epoch += 1;
  }

  writeMetaFrame(): void {
    appendFileSync(this.filePath, Buffer.from("meta"));
  }

  writeRecord(buffer: Buffer): void {
    appendFileSync(this.filePath, buffer);
  }

  getCurrentByteOffset(): number {
    return statSync(this.filePath).size;
  }

  flush(): void {}

  async stop(): Promise<ArchiveVerification> {
    this.active = false;
    if (!existsSync(this.filePath)) {
      return {
        state: "unavailable",
        sourceGeneration: null,
        details: "Recorder was not started",
      };
    }
    return {
      state: "verified",
      sourceGeneration: sha256ContentHash(
        readFileSync(this.filePath),
      ),
    };
  }
}

test("live pipeline persists provisional lap and finalized recording quality", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-quality-pipeline-"));
  try {
    const recorder = new TestSessionRecorder(join(directory, "session.bin"));
    const db = new CapturingDbAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
      bypassPacketRateFilter: true,
      recorder,
      skipDevState: true,
      skipHistorySeeding: true,
    });
    const packets = qualityPackets(40).map((packet, index) => ({
      ...packet,
      gameId: "fm-2023" as const,
      iracing: undefined,
      CarOrdinal: 100,
      CarClass: 1,
      CarPerformanceIndex: 800,
      TrackOrdinal: 5,
      LapNumber: 1,
      CurrentLap: index / 4,
      LastLap: 0,
    }));
    for (const [index, packet] of packets.entries()) {
      await pipeline.processPacket(packet, Buffer.from([index]));
    }
    await pipeline.processPacket(
      {
        ...packets[packets.length - 1]!,
        LapNumber: 2,
        CurrentLap: 0,
        LastLap: 10,
        TimestampMS: 2_100,
        DistanceTraveled: 5_100,
      },
      Buffer.from([40]),
    );
    await pipeline.finalizeCurrentSession();

    expect(db.laps).toHaveLength(1);
    expect(db.laps[0]?.quality?.provenance.outputGeneration).toBe("provisional");
    expect(db.laps[0]?.eligibility).not.toBeNull();
    expect(db.sessionQualities).toHaveLength(1);
    expect(db.sessionQualities[0]?.quality.archiveVerification.sourceGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
