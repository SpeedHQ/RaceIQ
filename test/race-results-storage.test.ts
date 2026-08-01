import { describe, expect, test } from "bun:test";
import {
  insertSession,
  getSessionResult,
  replacePitEvents,
  upsertSessionResult,
  type SessionResultInput,
} from "../server/db/queries";
import { getRecentRaceResults } from "../server/race-results/aggregates";
import type { RaceResultEvidence } from "../shared/race-results";

const evidence: RaceResultEvidence = {
  fieldStatus: {
    sessionType: "direct",
    classification: "direct",
    finishingPosition: "direct",
    qualifyingPosition: "direct",
    isPodium: "derived",
    isFastestLap: "derived",
    pitEvents: "derived",
    tyreStrategy: "simplified",
    fuelStrategy: "unavailable",
  },
  conflicts: [],
};

describe("persisted race result metadata", () => {
  test("upserts one result and replaces ordered pit events on rerun", async () => {
    const sessionId = await insertSession(99, 88, "f1-2025", "race");
    const input: SessionResultInput = {
      sessionId,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 2,
      qualifyingPosition: 5,
      isPodium: true,
      isFastestLap: false,
      pitCount: 2,
      tyreStrategy: { compounds: ["soft", "medium"] },
      fuelStrategy: null,
      provenance: { finishingPosition: "f1.grid" },
      evidence,
      reasons: [],
    };
    const first = await upsertSessionResult(input);
    const second = await upsertSessionResult(input);
    expect(second.id).toBe(first.id);
    await replacePitEvents(first.id, [
      { sequence: 2, lapNumber: 8, elapsedSeconds: 80, durationSeconds: 2.1, service: "fuel", tyreChange: null, fuelAdded: 5, fuelBefore: 10, fuelAfter: 15, linkage: "linked", source: { test: true } },
      { sequence: 1, lapNumber: 3, elapsedSeconds: 30, durationSeconds: null, service: "tyres", tyreChange: { to: "medium" }, fuelAdded: null, fuelBefore: null, fuelAfter: null, linkage: "linked", source: { test: true } },
    ]);
    const result = await getSessionResult(sessionId, "f1-2025");
    expect(result?.id).toBe(first.id);
    expect(result?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(result?.events[1]?.fuelAdded).toBe(5);
  });

  test("does not expose a result across game scope", async () => {
    const sessionId = await insertSession(99, 88, "acc", "race");
    await upsertSessionResult({
      sessionId,
      sessionType: "race",
      classification: "unknown",
      outcomeStatus: "unavailable",
      finishingPosition: null,
      qualifyingPosition: null,
      isPodium: null,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance: {},
      evidence: {
        ...evidence,
        fieldStatus: { ...evidence.fieldStatus, classification: "unavailable" },
      },
      reasons: ["unsupported"],
    });
    expect(await getSessionResult(sessionId, "f1-2025")).toBeNull();
  });
  test("returns newest persisted sessions without counting unpersisted gaps", async () => {
    const oldest = await insertSession(1, 1, "f1-2025", "race");
    await insertSession(1, 1, "f1-2025", "race");
    await insertSession(1, 1, "f1-2025", "race");
    await upsertSessionResult({
      sessionId: oldest,
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed",
      finishingPosition: 1,
      qualifyingPosition: null,
      isPodium: true,
      isFastestLap: null,
      pitCount: 0,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance: {},
      evidence,
      reasons: [],
    });
    const results = await getRecentRaceResults("f1-2025", 2);
    expect(results[0]?.sessionId).toBe(oldest);
    expect(results.map((result) => result.sessionId)).not.toContain(oldest + 1);
    expect(results.map((result) => result.sessionId)).not.toContain(oldest + 2);
  });

});
