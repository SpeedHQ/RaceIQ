import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { insertSession } from "@raceiq/backend-core/db/session-queries";
import { db } from "@raceiq/backend-core/db/index";
import { laps } from "@raceiq/backend-core/db/schema";
import { upsertSessionResult } from "@raceiq/backend-core/db/session-result-queries";
import { evidence, provenance } from "@raceiq/backend/test-support/race-results";
  test("LMU in-pits event at lap start does not override detected out-lap", async () => {
    const sessionId = await insertSession("lmu-car", "lmu-track", "lmu", "race");
    await db.insert(laps).values([
      { sessionId, lapNumber: 2, lapTime: 102.7, isValid: true, invalidReason: null, classification: "out_lap" },
      { sessionId, lapNumber: 3, lapTime: 85.1, isValid: true, invalidReason: null, classification: "pace" },
    ]);
    await upsertSessionResult({
      sessionId,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: false,
      pitCount: 1,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance,
      evidence,
      reasons: [],
    }, [{
      sequence: 1,
      lapNumber: 2,
      elapsedSeconds: 0.16,
      durationSeconds: null,
      service: "unknown",
      tyreChange: null,
      fuelAdded: null,
      fuelBefore: null,
      fuelAfter: null,
      linkage: "linked",
      source: { channel: "lmu.inPits", value: true },
    }]);

    const stored = await db.select({
      lapNumber: laps.lapNumber,
      classification: laps.classification,
    }).from(laps).where(eq(laps.sessionId, sessionId)).orderBy(laps.lapNumber).all();
    expect(stored).toEqual([
      { lapNumber: 2, classification: "out_lap" },
      { lapNumber: 3, classification: "out_lap" },
    ]);
  });
