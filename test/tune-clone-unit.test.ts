import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../server/db/index";
import { communityTunes, tunes } from "../server/db/schema";
import { tuneCrudRoutes } from "../server/routes/tunes";

// Community tunes are imperial-denominated with no unit metadata. A clone must
// carry that fact so the settings panel doesn't render psi/lb values as metric.
const COMMUNITY_SETTINGS = JSON.stringify({
  tires: { frontPressure: 28, rearPressure: 28 },
  springs: { frontRate: 400, rearRate: 430 },
});

beforeEach(async () => {
  await db.delete(tunes).run();
  await db.delete(communityTunes).run();
});

describe("POST /api/tunes/clone/:catalogId", () => {
  test("stamps the cloned tune as imperial", async () => {
    await db
      .insert(communityTunes)
      .values({
        id: "community-clone-test",
        gameId: "fm-2023",
        carOrdinal: 2860,
        name: "Community tune",
        author: "tester",
        category: "circuit",
        sourceName: "test",
        settings: COMMUNITY_SETTINGS,
      })
      .run();

    const response = await tuneCrudRoutes.request("/api/tunes/clone/community-clone-test", { method: "POST" });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { unitSystem?: string };
    expect(body.unitSystem).toBe("imperial");

    const row = await db.select().from(tunes).where(eq(tunes.catalogId, "community-clone-test")).get();
    expect(row?.unitSystem).toBe("imperial");
  });
});
