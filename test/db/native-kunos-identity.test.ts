import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db/index";
import { sessions } from "../../server/db/schema";
import { insertSession, deleteSession } from "../../server/db/session-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { getLapById } from "../../server/db/lap-read-queries";
import { backfillNativeKunosSessionIdentity } from "../../server/db/telemetry-replay-storage";
import { sessionRoutes } from "../../server/routes/session-routes";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";

initGameAdapters();
initServerGameAdapters();
const ACC_CAPTURE = "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz";
const ownedSessions: number[] = [];

afterEach(async () => {
  for (const id of ownedSessions.splice(0)) await deleteSession(id);
});

describe("historical Kunos native identity", () => {
  test("recovers committed ACC capture through session, lap metadata, and HTTP without overwriting native text", async () => {
    const id = await insertSession("-1", "-1", "acc", "race");
    ownedSessions.push(id);
    await db.update(sessions).set({ rawFile: ACC_CAPTURE }).where(eq(sessions.id, id)).run();
    const lapId = await insertLap(id, 1, 95, true, null, 1);

    await backfillNativeKunosSessionIdentity();
    const session = await db.select().from(sessions).where(eq(sessions.id, id)).get();
    expect(session).toMatchObject({ carId: "mclaren_720s_gt3_evo", trackId: "brands_hatch" });
    expect(await getLapById(lapId)).toMatchObject({ carId: "mclaren_720s_gt3_evo", trackId: "brands_hatch" });

    const response = await sessionRoutes.request("/api/sessions?gameId=acc");
    expect(response.status).toBe(200);
    const rows = await response.json() as Array<{ id: number; carId: string; trackId: string }>;
    expect(rows.find((row) => row.id === id)).toMatchObject({ carId: "mclaren_720s_gt3_evo", trackId: "brands_hatch" });

    await backfillNativeKunosSessionIdentity();
    const again = await db.select({ carId: sessions.carId, trackId: sessions.trackId }).from(sessions).where(eq(sessions.id, id)).get();
    expect(again).toEqual({ carId: "mclaren_720s_gt3_evo", trackId: "brands_hatch" });
  });

  test("missing old capture stays addressable as unresolved decimal identity", async () => {
    const id = await insertSession("321", "654", "ac-evo");
    ownedSessions.push(id);
    await db.update(sessions).set({ rawFile: "/missing/legacy-ac-evo.bin.gz" }).where(eq(sessions.id, id)).run();
    await backfillNativeKunosSessionIdentity();
    const session = await db.select({ carId: sessions.carId, trackId: sessions.trackId }).from(sessions).where(eq(sessions.id, id)).get();
    expect(session).toEqual({ carId: "321", trackId: "654" });
  });
});
