import { describe, test, expect, spyOn } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
import { RealDbAdapter, CapturingDbAdapter, NullWsAdapter } from "../../server/telemetry/pipeline-ports";
import * as DriverProfileRunner from "../../server/driver-profile/runner";
import type { PersistLapInput } from "../../server/db/lap-mutation-queries";

function lapInput(sessionId: number, lapNumber = 1, overrides: Partial<PersistLapInput> = {}): PersistLapInput {
  return {
    sessionId,
    lapNumber,
    lapTime: 90000,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 0,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    classification: DEFAULT_LAP_CLASSIFICATION,
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
    const id = await db.insertLap(lapInput(1));
    expect(id).toBe(1);
    expect(db.laps).toHaveLength(1);
    expect(db.laps[0]).toMatchObject({
      sessionId: 1,
      lapNumber: 1,
      lapTime: 90000,
      isValid: true,
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    });
  });

  test("insertLap captures sectors", async () => {
    const db = new CapturingDbAdapter();
    await db.insertSession(1, 1, "f1-2025");
    await db.insertLap(lapInput(1, 1, { sectors: [30000, 30000, 30000] }));
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
    await db.insertLap(lapInput(sessionId));
    await db.insertLap(
      lapInput(sessionId, 2, {
        lapTime: 91000,
        isValid: false,
        invalidReason: "dirty",
      }),
    );
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
    await db.insertLap(lapInput(sessionId));
    expect(notify).not.toHaveBeenCalled();
  } finally {
    notify.mockRestore();
  }
});

describe("NullWsAdapter", () => {
  test("all methods are no-ops and do not throw", () => {
    const ws = new NullWsAdapter();
    expect(() => ws.stageDevTelemetry({ gameId: "f1-2025" } as TelemetryPacket)).not.toThrow();
    expect(() =>
      ws.publishTelemetry({
        sample: { sequence: "0", observedAtMs: 0, values: {} },
      }),
    ).not.toThrow();
    expect(() => ws.broadcastNotification({ type: "test" })).not.toThrow();
    expect(() => ws.broadcastDevState({ key: "value" })).not.toThrow();
  });
});
