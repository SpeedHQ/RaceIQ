import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { trackCorners, trackOutlines } from "@raceiq/backend-core/db/schema";
import { getCorners, getTrackOutline, saveCorners } from "@raceiq/backend-core/db/track-queries";

describe("ACC legacy geometry", () => {
  test("reads unique legacy identities while keeping ambiguous layouts and other games separate", async () => {
    const corner = { index: 1, label: "T1", distanceStart: 10, distanceEnd: 20 };
    const outline = [{ x: 1, z: 2, speed: 3 }];
    const ids = ["22", "kyalami", "8", "barcelona"];
    try {
      await saveCorners("22", [corner], "acc");
      await saveCorners("8", [corner], "acc");
      await db.insert(trackOutlines).values([
        { gameId: "acc", trackId: "22", outline: Buffer.from(Bun.gzipSync(JSON.stringify(outline))) },
        { gameId: "acc", trackId: "8", outline: Buffer.from(Bun.gzipSync(JSON.stringify(outline))) },
      ]).run();
      expect(await getCorners("kyalami", "acc")).toEqual([corner]);
      expect(await getTrackOutline("kyalami", "acc")).toEqual(outline);
      expect(await getCorners("barcelona", "acc")).toEqual([]);
      expect(await getTrackOutline("barcelona", "acc")).toBeNull();
      expect(await getCorners("kyalami", "ac-evo")).toEqual([]);
      expect(await getTrackOutline("kyalami", "ac-evo")).toBeNull();
      await saveCorners("kyalami", [{ ...corner, label: "Native" }], "acc", true);
      expect(await getCorners("kyalami", "acc", { manualOnly: true })).toEqual([]);
      expect((await getCorners("kyalami", "acc"))[0].label).toBe("Native");
      expect(await getCorners("22", "acc")).toEqual([corner]);
    } finally {
      await db.delete(trackCorners).where(and(eq(trackCorners.gameId, "acc"), inArray(trackCorners.trackId, ids))).run();
      await db.delete(trackOutlines).where(and(eq(trackOutlines.gameId, "acc"), inArray(trackOutlines.trackId, ids))).run();
    }
  });
});
