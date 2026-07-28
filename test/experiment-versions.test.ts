import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../server/db/index";
import { experiments, experimentVersions } from "../server/db/schema";
import { createExperiment } from "../server/db/experiment-queries";
import {
  createExperimentVersion,
  getExperimentVersion,
  getExperimentVersionsByLabel,
  listExperimentVersions,
  nextVersion,
  setExperimentVersionNotes,
} from "../server/db/experiment-version-queries";

/** Query layer behind the experiment-versions endpoints — the setup versions under
 *  evaluation inside a tuning session (plan §2). Tests the DB layer directly
 *  (importing the composed app would bind the UDP socket as a side effect). */
describe("tuning-test queries", () => {
  beforeEach(async () => {
    // experiment_versions cascades from experiments, but clear both explicitly so
    // the test is order-independent.
    await db.delete(experimentVersions).run();
    await db.delete(experiments).run();
  });

  async function seedSession(): Promise<number> {
    return createExperiment({
      gameId: "ac-evo",
      name: "Mugello GT3",
      carName: "Ferrari 296 GT3",
      trackName: "mugello",
      baseSetupPath: "/x/Setups/car/track/base.json",
    });
  }

  test("create → get round-trips a version, carrying setup + diff", async () => {
    const sessionId = await seedSession();
    const id = await createExperimentVersion({
      experimentId: sessionId,
      version: 1,
      label: "base",
      setupPath: "/x/Setups/car/track/base.json",
      appliedChanges: JSON.stringify([{ component: "frontARB", from: 5, to: 4 }]),
      engine: "rules",
    });
    expect(id).toBeGreaterThan(0);
    const row = await getExperimentVersion(id);
    expect(row?.label).toBe("base");
    expect(row?.version).toBe(1);
    expect(row?.status).toBe("active");
    expect(row?.setupPath).toBe("/x/Setups/car/track/base.json");
    expect(JSON.parse(row!.appliedChanges!)).toEqual([{ component: "frontARB", from: 5, to: 4 }]);
  });

  test("engineer notes: set returns prior value, clears with null, distinct from driver comment", async () => {
    const sessionId = await seedSession();
    const id = await createExperimentVersion({
      experimentId: sessionId,
      version: 1,
      label: "base",
      driverComment: "felt loose on entry",
    });

    // First write: prior value was null (new column).
    expect(await setExperimentVersionNotes(id, "softened front ARB, retry next stint")).toBeNull();
    let row = await getExperimentVersion(id);
    expect(row?.notes).toBe("softened front ARB, retry next stint");
    // Never touches the driver's feel comment.
    expect(row?.driverComment).toBe("felt loose on entry");

    // Overwrite returns the prior note (undo inverse).
    expect(await setExperimentVersionNotes(id, "v2 plan: raise rear ride height")).toBe(
      "softened front ARB, retry next stint",
    );

    // Clear with null.
    expect(await setExperimentVersionNotes(id, null)).toBe("v2 plan: raise rear ride height");
    row = await getExperimentVersion(id);
    expect(row?.notes).toBeNull();
  });

  test("getExperimentVersionsByLabel resolves a node by its version within the session", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await createExperimentVersion({ experimentId: a, version: 1, label: "base" });
    await createExperimentVersion({ experimentId: a, version: 2, label: "v2" });
    await createExperimentVersion({ experimentId: b, version: 1, label: "other base" });

    expect((await getExperimentVersionsByLabel(a, 2))?.label).toBe("v2");
    // Scoped to the session — b's v1 is not a's v1.
    expect((await getExperimentVersionsByLabel(a, 1))?.label).toBe("base");
    expect(await getExperimentVersionsByLabel(a, 99)).toBeUndefined();
  });

  test("list is scoped to the session and ordered oldest-first by version", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await createExperimentVersion({ experimentId: a, version: 1, label: "base" });
    await createExperimentVersion({ experimentId: a, version: 2, label: "Front ARB -1" });
    await createExperimentVersion({ experimentId: b, version: 1, label: "other base" });

    const forA = await listExperimentVersions(a);
    expect(forA).toHaveLength(2);
    expect(forA.every((t) => t.experimentId === a)).toBe(true);
    expect(forA.map((t) => t.version)).toEqual([1, 2]);
    expect(forA.map((t) => t.label)).toEqual(["base", "Front ARB -1"]);
  });

  test("nextVersion is 1 for an empty session and increments from the max", async () => {
    const sessionId = await seedSession();
    expect(await nextVersion(sessionId)).toBe(1);

    await createExperimentVersion({ experimentId: sessionId, version: 1, label: "base" });
    expect(await nextVersion(sessionId)).toBe(2);

    await createExperimentVersion({ experimentId: sessionId, version: 2, label: "v2" });
    expect(await nextVersion(sessionId)).toBe(3);
  });

  test("deleting the parent session cascades to its tests", async () => {
    const sessionId = await seedSession();
    await createExperimentVersion({ experimentId: sessionId, version: 1, label: "base" });
    expect(await listExperimentVersions(sessionId)).toHaveLength(1);

    await db.delete(experiments).where(eq(experiments.id, sessionId)).run();
    expect(await listExperimentVersions(sessionId)).toHaveLength(0);
  });
});
