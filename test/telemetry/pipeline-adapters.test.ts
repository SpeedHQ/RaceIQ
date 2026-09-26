import { test, expect, spyOn } from "bun:test";
import { RealDbAdapter } from "../../server/telemetry/pipeline-ports";
import * as DriverProfileRunner from "../../server/driver-profile/runner";


test("RealDbAdapter notifies global profile after valid and dirty persisted laps", async () => {
  const notify = spyOn(DriverProfileRunner, "notifyDriverProfileLap").mockImplementation(() => {});
  try {
    const db = new RealDbAdapter();
    const sessionId = await db.insertSession("1", "1", "f1-2025");
    await db.insertLap(sessionId, 1, 90000, true, null, 0, null, null, null, null);
    await db.insertLap(sessionId, 2, 91000, false, null, 0, null, null, "dirty", null);
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
    const sessionId = await db.insertSession("1", "1", "f1-2025");
    await db.insertLap(sessionId, 1, 90000, true, null, 0, null, null, null, null);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    notify.mockRestore();
  }
});
