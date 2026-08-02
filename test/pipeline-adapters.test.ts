import { describe, test, expect, spyOn } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { RealDbAdapter, CapturingDbAdapter, NullWsAdapter } from "../server/telemetry/pipeline-ports"
import * as DriverProfileRunner from "../server/driver-profile/runner";

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
    const id = await db.insertLap(1, 1, 90000, true, null, 0, null, null, null, null);
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
    await db.insertLap(1, 1, 90000, true, null, 0, null, null, null, [30000, 30000, 30000]);
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
    await db.insertLap(sessionId, 1, 90000, true, null, 0, null, null, null, null);
    await db.insertLap(sessionId, 2, 91000, false, null, 0, null, null, "dirty", null);
    expect(notify).toHaveBeenNthCalledWith(1, "f1-2025");
    expect(notify).toHaveBeenNthCalledWith(2, "f1-2025");
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
