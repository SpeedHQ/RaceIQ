import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../server/db/index";
import { tuningSessions, tuningTests } from "../server/db/schema";
import { createTuningSession } from "../server/db/tuning-session-queries";
import {
  createTuningTest,
  getTuningTest,
  listTuningTests,
  nextVersion,
} from "../server/db/tuning-test-queries";

/** Query layer behind the tuning-tests endpoints — the setup versions under
 *  evaluation inside a tuning session (plan §2). Tests the DB layer directly
 *  (importing the composed app would bind the UDP socket as a side effect). */
describe("tuning-test queries", () => {
  beforeEach(async () => {
    // tuning_tests cascades from tuning_sessions, but clear both explicitly so
    // the test is order-independent.
    await db.delete(tuningTests).run();
    await db.delete(tuningSessions).run();
  });

  async function seedSession(): Promise<number> {
    return createTuningSession({
      gameId: "ac-evo",
      name: "Mugello GT3",
      carName: "Ferrari 296 GT3",
      trackName: "mugello",
      baseSetupPath: "/x/Setups/car/track/base.json",
    });
  }

  test("create → get round-trips a version, carrying setup + diff", async () => {
    const sessionId = await seedSession();
    const id = await createTuningTest({
      tuningSessionId: sessionId,
      version: 1,
      label: "base",
      setupPath: "/x/Setups/car/track/base.json",
      appliedChanges: JSON.stringify([{ component: "frontARB", from: 5, to: 4 }]),
      engine: "rules",
    });
    expect(id).toBeGreaterThan(0);
    const row = await getTuningTest(id);
    expect(row?.label).toBe("base");
    expect(row?.version).toBe(1);
    expect(row?.status).toBe("active");
    expect(row?.setupPath).toBe("/x/Setups/car/track/base.json");
    expect(JSON.parse(row!.appliedChanges!)).toEqual([{ component: "frontARB", from: 5, to: 4 }]);
  });

  test("list is scoped to the session and ordered oldest-first by version", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await createTuningTest({ tuningSessionId: a, version: 1, label: "base" });
    await createTuningTest({ tuningSessionId: a, version: 2, label: "Front ARB -1" });
    await createTuningTest({ tuningSessionId: b, version: 1, label: "other base" });

    const forA = await listTuningTests(a);
    expect(forA).toHaveLength(2);
    expect(forA.every((t) => t.tuningSessionId === a)).toBe(true);
    expect(forA.map((t) => t.version)).toEqual([1, 2]);
    expect(forA.map((t) => t.label)).toEqual(["base", "Front ARB -1"]);
  });

  test("nextVersion is 1 for an empty session and increments from the max", async () => {
    const sessionId = await seedSession();
    expect(await nextVersion(sessionId)).toBe(1);

    await createTuningTest({ tuningSessionId: sessionId, version: 1, label: "base" });
    expect(await nextVersion(sessionId)).toBe(2);

    await createTuningTest({ tuningSessionId: sessionId, version: 2, label: "v2" });
    expect(await nextVersion(sessionId)).toBe(3);
  });

  test("deleting the parent session cascades to its tests", async () => {
    const sessionId = await seedSession();
    await createTuningTest({ tuningSessionId: sessionId, version: 1, label: "base" });
    expect(await listTuningTests(sessionId)).toHaveLength(1);

    await db.delete(tuningSessions).where(eq(tuningSessions.id, sessionId)).run();
    expect(await listTuningTests(sessionId)).toHaveLength(0);
  });
});
