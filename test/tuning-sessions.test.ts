import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../server/db/index";
import { tuningSessions } from "../server/db/schema";
import {
  createTuningSession,
  getTuningSession,
  listTuningSessions,
  updateTuningSession,
} from "../server/db/tuning-session-queries";

/** Query layer behind the tuning-sessions endpoints — the Setup Engineer front
 *  door (plan §6a). Tests the DB layer directly (importing the composed app
 *  would bind the UDP socket as a side effect). */
describe("tuning-session queries", () => {
  beforeEach(async () => {
    await db.delete(tuningSessions).run();
  });

  test("create → get round-trips, carrying the base setup + car/track names", async () => {
    const id = await createTuningSession({
      gameId: "ac-evo",
      name: "Mugello GT3",
      carName: "Ferrari 296 GT3",
      trackName: "mugello",
      baseSetupPath: "/x/Setups/car/track/base.json",
    });
    expect(id).toBeGreaterThan(0);
    const row = await getTuningSession(id);
    expect(row?.name).toBe("Mugello GT3");
    expect(row?.status).toBe("active");
    expect(row?.baseSetupPath).toBe("/x/Setups/car/track/base.json");
    expect(row?.trackName).toBe("mugello");
  });

  test("list is scoped by gameId and newest-first", async () => {
    await createTuningSession({ gameId: "ac-evo", name: "A" });
    await createTuningSession({ gameId: "acc", name: "B" });
    const evo = await listTuningSessions("ac-evo");
    expect(evo).toHaveLength(1);
    expect(evo.every((r) => r.gameId === "ac-evo")).toBe(true);
  });

  test("seq counts from 1 per game, independent of the churned id", async () => {
    const e1 = await getTuningSession(await createTuningSession({ gameId: "ac-evo", name: "E1" }));
    const e2 = await getTuningSession(await createTuningSession({ gameId: "ac-evo", name: "E2" }));
    const a1 = await getTuningSession(await createTuningSession({ gameId: "acc", name: "A1" }));
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    // Separate per-game counter — acc starts at 1 even though the raw id is higher.
    expect(a1?.seq).toBe(1);
    expect(a1!.id).toBeGreaterThan(e1!.id);
  });

  test("archiving removes a session from the default list", async () => {
    const id = await createTuningSession({ gameId: "acc", name: "Old" });
    expect(await updateTuningSession(id, { status: "archived" })).toBe(true);

    const active = await listTuningSessions("acc");
    expect(active.find((r) => r.id === id)).toBeUndefined();

    const all = await listTuningSessions("acc", { includeArchived: true });
    expect(all.find((r) => r.id === id)?.status).toBe("archived");
  });

  test("update of a missing session reports no rows changed", async () => {
    expect(await updateTuningSession(999999, { name: "nope" })).toBe(false);
  });
});
