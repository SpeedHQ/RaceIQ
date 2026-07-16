import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../server/db/index";
import { laps, sessions, tuningSessions } from "../server/db/schema";
import { getLapsForTuningSession, insertLap, insertSession } from "../server/db/queries";
import { createTuningSession } from "../server/db/tuning-session-queries";
import { getActiveTuningSession, setActiveTuningSession } from "../server/tuning-active";

/**
 * Explicit lap ↔ tuning-session link (migration v25). Tests the DB layer +
 * active-session module directly — importing the composed app would bind the
 * UDP socket as a side effect (EADDRINUSE). Creates only its own rows and
 * cleans them up so the dev DB's real laps/sessions are left untouched.
 */
describe("lap ↔ tuning-session explicit link", () => {
  const createdSessionIds: number[] = [];
  const createdTuningIds: number[] = [];

  beforeEach(() => {
    setActiveTuningSession(null);
    createdSessionIds.length = 0;
    createdTuningIds.length = 0;
  });

  afterEach(async () => {
    setActiveTuningSession(null);
    // Delete only the rows this test created (laps cascade from their sessions).
    if (createdSessionIds.length) {
      await db.delete(laps).where(inArray(laps.sessionId, createdSessionIds)).run();
      await db.delete(sessions).where(inArray(sessions.id, createdSessionIds)).run();
    }
    if (createdTuningIds.length) {
      await db.delete(tuningSessions).where(inArray(tuningSessions.id, createdTuningIds)).run();
    }
  });

  test("insertLap stamps the active session; getLapsForTuningSession spans race sessions and excludes unlinked laps", async () => {
    const tsId = await createTuningSession({ gameId: "acc", name: "Link test" });
    createdTuningIds.push(tsId);

    // Race session A. First lap recorded with NO active tuning session → unlinked.
    const raceA = await insertSession(1, 2, "acc");
    createdSessionIds.push(raceA);
    const unlinkedLap = await insertLap(raceA, 1, 90000, true, null, 0);

    // Activate, then record laps across TWO different race sessions.
    setActiveTuningSession(tsId);
    expect(getActiveTuningSession()).toBe(tsId);
    const linkedA = await insertLap(raceA, 2, 89000, true, null, 0);

    const raceB = await insertSession(1, 2, "acc");
    createdSessionIds.push(raceB);
    const linkedB = await insertLap(raceB, 1, 88000, true, null, 0);

    // Deactivate → subsequent laps are unlinked again.
    setActiveTuningSession(null);
    const afterLap = await insertLap(raceB, 2, 91000, true, null, 0);

    const linked = await getLapsForTuningSession(tsId);
    const ids = linked.map((l) => l.id).sort((a, b) => a - b);

    expect(ids).toEqual([linkedA, linkedB].sort((a, b) => a - b));
    // Membership spans two distinct race sessions.
    expect(new Set(linked.map((l) => l.sessionId)).size).toBe(2);
    // Laps recorded outside the active window are excluded.
    expect(ids).not.toContain(unlinkedLap);
    expect(ids).not.toContain(afterLap);
    // Every returned lap carries the link.
    expect(linked.every((l) => l.tuningSessionId === tsId)).toBe(true);
  });

  test("a session with no laps recorded while active returns an empty pool", async () => {
    const tsId = await createTuningSession({ gameId: "ac-evo", name: "Empty" });
    createdTuningIds.push(tsId);
    expect(await getLapsForTuningSession(tsId)).toHaveLength(0);
  });
});
