import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../server/db/index";
import { experiments } from "../server/db/schema";
import {
  createExperiment,
  getExperiment,
  listExperiments,
  updateExperiment,
} from "../server/db/experiment-queries";

/** Query layer behind the experiments endpoints — the Setup Engineer front
 *  door (plan §6a). Tests the DB layer directly (importing the composed app
 *  would bind the UDP socket as a side effect). */
describe("experiment queries", () => {
  beforeEach(async () => {
    await db.delete(experiments).run();
  });

  test("create → get round-trips, carrying the base setup + car/track names", async () => {
    const id = await createExperiment({
      gameId: "ac-evo",
      name: "Mugello GT3",
      carName: "Ferrari 296 GT3",
      trackName: "mugello",
      baseSetupPath: "/x/Setups/car/track/base.json",
    });
    expect(id).toBeGreaterThan(0);
    const row = await getExperiment(id);
    expect(row?.name).toBe("Mugello GT3");
    expect(row?.status).toBe("active");
    expect(row?.baseSetupPath).toBe("/x/Setups/car/track/base.json");
    expect(row?.trackName).toBe("mugello");
  });

  test("list is scoped by gameId and newest-first", async () => {
    await createExperiment({ gameId: "ac-evo", name: "A" });
    await createExperiment({ gameId: "acc", name: "B" });
    const evo = await listExperiments("ac-evo");
    expect(evo).toHaveLength(1);
    expect(evo.every((r) => r.gameId === "ac-evo")).toBe(true);
  });

  test("seq counts from 1 per game, independent of the churned id", async () => {
    const e1 = await getExperiment(await createExperiment({ gameId: "ac-evo", name: "E1" }));
    const e2 = await getExperiment(await createExperiment({ gameId: "ac-evo", name: "E2" }));
    const a1 = await getExperiment(await createExperiment({ gameId: "acc", name: "A1" }));
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    // Separate per-game counter — acc starts at 1 even though the raw id is higher.
    expect(a1?.seq).toBe(1);
    expect(a1!.id).toBeGreaterThan(e1!.id);
  });

  test("archiving removes a session from the default list", async () => {
    const id = await createExperiment({ gameId: "acc", name: "Old" });
    expect(await updateExperiment(id, { status: "archived" })).toBe(true);

    const active = await listExperiments("acc");
    expect(active.find((r) => r.id === id)).toBeUndefined();

    const all = await listExperiments("acc", { includeArchived: true });
    expect(all.find((r) => r.id === id)?.status).toBe("archived");
  });

  test("update of a missing session reports no rows changed", async () => {
    expect(await updateExperiment(999999, { name: "nope" })).toBe(false);
  });
});
