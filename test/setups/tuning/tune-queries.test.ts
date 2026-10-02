import { describe, test, expect, beforeEach } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../../server/db/index";
import { tunes, tuneAssignments, laps, sessions } from "../../../server/db/schema";
import {
  insertTune,
  getTunes,
  getTuneById,
  updateTune,
  deleteTune,
  setTuneAssignment,
  getTuneAssignment,
  getTuneAssignments,
  deleteTuneAssignment,
  getTuneUsage,
} from "../../../server/db/tune-queries";

const TEST_SETTINGS = JSON.stringify({
  tires: { frontPressure: 30.5, rearPressure: 31.0 },
  gearing: { finalDrive: 3.42 },
  alignment: { frontCamber: -1.2, rearCamber: -0.8, frontToe: 0, rearToe: 0.1 },
  antiRollBars: { front: 22.4, rear: 18.6 },
  springs: { frontRate: 750, rearRate: 680, frontHeight: 5.2, rearHeight: 5.4 },
  damping: { frontRebound: 8.2, rearRebound: 7.4, frontBump: 5.1, rearBump: 4.8 },
  aero: { frontDownforce: 185, rearDownforce: 220 },
  differential: { rearAccel: 72, rearDecel: 45 },
  brakes: { balance: 54, pressure: 95 },
});

beforeEach(async () => {
  await db.delete(tuneAssignments).run();
  await db.delete(tunes).run();
});

describe("tune CRUD", () => {
  test("insertTune creates and returns tune with id", async () => {
    const id = await insertTune({
      gameId: "fm-2023",
      name: "Test Tune",
      author: "tester",
      carOrdinal: 2860,
      category: "circuit",
      description: "A test tune",
      settings: TEST_SETTINGS,
    });
    expect(id).toBeGreaterThan(0);
  });

  test("getTuneById returns inserted tune", async () => {
    const id = await insertTune({
      gameId: "fm-2023",
      name: "Test Tune",
      author: "tester",
      carOrdinal: 2860,
      category: "circuit",
      description: "A test tune",
      settings: TEST_SETTINGS,
    });
    const tune = await getTuneById(id);
    expect(tune).not.toBeNull();
    expect(tune!.name).toBe("Test Tune");
    expect(tune!.carOrdinal).toBe(2860);
  });

  test("getTunes filters by carOrdinal", async () => {
    await insertTune({ gameId: "fm-2023", name: "A", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    await insertTune({ gameId: "fm-2023", name: "B", author: "t", carOrdinal: 200, category: "wet", description: "", settings: TEST_SETTINGS });
    const filtered = await getTunes({ carOrdinal: 100 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("A");
  });

  test("getTunes reports fastest valid lap for exact setup and matching session identity", async () => {
    const data = { gameId: "ac-evo", name: "Recorded setup", author: "t", carOrdinal: 100, category: "race", description: "", settings: "{}" };
    const tuneId = await insertTune(data);
    const otherTuneId = await insertTune({ ...data, name: "Unused setup" });
    const fixtures = await db.insert(sessions).values([
      { gameId: "ac-evo", carOrdinal: 100, trackOrdinal: 1 },
      { gameId: "ac-evo", carOrdinal: 100, trackOrdinal: 2 },
      { gameId: "acc", carOrdinal: 100, trackOrdinal: 1 },
      { gameId: "ac-evo", carOrdinal: 200, trackOrdinal: 1 },
    ]).returning({ id: sessions.id }).all();
    const sessionIds = fixtures.map((session) => session.id);
    try {
      await db.insert(laps).values([
        { sessionId: sessionIds[0], tuneId, lapNumber: 1, lapTime: 101.2, isValid: true },
        { sessionId: sessionIds[1], tuneId, lapNumber: 1, lapTime: 92.345, isValid: true },
        { sessionId: sessionIds[0], tuneId, lapNumber: 2, lapTime: 80, isValid: false },
        { sessionId: sessionIds[0], tuneId, lapNumber: 3, lapTime: 0, isValid: true },
        { sessionId: sessionIds[0], tuneId, lapNumber: 4, lapTime: -1, isValid: true },
        { sessionId: sessionIds[0], tuneId: null, lapNumber: 5, lapTime: 50, isValid: true },
        { sessionId: sessionIds[2], tuneId, lapNumber: 1, lapTime: 60, isValid: true },
        { sessionId: sessionIds[3], tuneId, lapNumber: 1, lapTime: 70, isValid: true },
      ]).run();
      const listed = await getTunes({ gameId: "ac-evo", carOrdinal: 100 });
      expect(listed.find((tune) => tune.id === tuneId)?.bestLapTime).toBe(92.345);
      expect(listed.find((tune) => tune.id === otherTuneId)?.bestLapTime).toBeNull();
      await updateTune(tuneId, { trackOrdinal: 1 });
      expect((await getTuneById(tuneId))?.trackOrdinal).toBe(1);
      expect((await getTunes()).find((tune) => tune.id === tuneId)?.bestLapTime).toBe(101.2);
      await updateTune(tuneId, { trackOrdinal: 3 });
      expect((await getTunes()).find((tune) => tune.id === tuneId)?.bestLapTime).toBeNull();
      await updateTune(tuneId, { trackOrdinal: null });
      expect((await getTuneById(tuneId))?.trackOrdinal).toBeNull();
      expect((await getTunes()).find((tune) => tune.id === tuneId)?.bestLapTime).toBe(92.345);
      await db.delete(laps).where(eq(laps.tuneId, tuneId)).run();
      expect((await getTunes()).find((tune) => tune.id === tuneId)?.bestLapTime).toBeNull();
    } finally {
      await db.delete(sessions).where(inArray(sessions.id, sessionIds)).run();
    }
  });

  test("updateTune modifies fields", async () => {
    const id = await insertTune({ gameId: "fm-2023", name: "Old", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const updated = await updateTune(id, { name: "New" });
    expect(updated).toBe(true);
    expect((await getTuneById(id))!.name).toBe("New");
  });


  test("getTuneUsage groups linked laps and reports defaults; deleting tune preserves recordings", async () => {
    const data = { gameId: "ac-evo", name: "Referenced setup", author: "t", carOrdinal: 100, category: "race", description: "", settings: "{}" };
    const tuneId = await insertTune(data);
    const unrelatedTuneId = await insertTune({ ...data, name: "Other setup" });
    const sessionRows = await db.insert(sessions).values([
      { gameId: "ac-evo", carOrdinal: 100, trackOrdinal: 1, carId: "car-a", trackId: "track-a", createdAt: "2026-01-01" },
      { gameId: "ac-evo", carOrdinal: 100, trackOrdinal: 2, carId: "car-a", trackId: "track-b", createdAt: "2026-01-02" },
      { gameId: "ac-evo", carOrdinal: 200, trackOrdinal: 3 },
    ]).returning({ id: sessions.id }).all();
    const [first, second, unrelated] = sessionRows.map((row) => row.id);
    try {
      const lapRows = await db.insert(laps).values([
        { sessionId: first, tuneId, lapNumber: 3, lapTime: 100, isValid: true },
        { sessionId: first, tuneId, lapNumber: 4, lapTime: 99, isValid: true },
        { sessionId: second, tuneId, lapNumber: 1, lapTime: 98, isValid: true },
        { sessionId: unrelated, tuneId: unrelatedTuneId, lapNumber: 2, lapTime: 97, isValid: true },
      ]).returning({ id: laps.id }).all();
      await setTuneAssignment("ac-evo", 100, 1, tuneId);
      const usage = await getTuneUsage(tuneId);
      expect(usage).toEqual({
        sessions: [
          { sessionId: first, gameId: "ac-evo", createdAt: "2026-01-01", carOrdinal: 100, trackOrdinal: 1, carId: "car-a", trackId: "track-a", laps: [{ id: lapRows[0].id, lapNumber: 3 }, { id: lapRows[1].id, lapNumber: 4 }] },
          { sessionId: second, gameId: "ac-evo", createdAt: "2026-01-02", carOrdinal: 100, trackOrdinal: 2, carId: "car-a", trackId: "track-b", laps: [{ id: lapRows[2].id, lapNumber: 1 }] },
        ],
        assignments: [{ gameId: "ac-evo", carOrdinal: 100, trackOrdinal: 1 }],
      });
      expect(await deleteTune(tuneId)).toBe(true);
      expect(await getTuneUsage(tuneId)).toBeNull();
      const persisted = await db.select({ id: laps.id, sessionId: laps.sessionId, tuneId: laps.tuneId }).from(laps).where(inArray(laps.id, lapRows.slice(0, 3).map((row) => row.id))).all();
      expect(persisted).toEqual(lapRows.slice(0, 3).map((row, index) => ({ id: row.id, sessionId: [first, first, second][index], tuneId: null })));
      expect((await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, [first, second, unrelated])).all()).map((row) => row.id)).toEqual([first, second, unrelated]);
      expect((await getTuneUsage(unrelatedTuneId))?.sessions).toHaveLength(1);
      expect(await getTuneUsage(-1)).toBeNull();
    } finally {
      await db.delete(sessions).where(inArray(sessions.id, sessionRows.map((row) => row.id))).run();
    }
  });
  test("deleteTune removes tune", async () => {
    const id = await insertTune({ gameId: "fm-2023", name: "X", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    expect(await deleteTune(id)).toBe(true);
    expect(await getTuneById(id)).toBeNull();
  });
});

describe("tune assignments", () => {
  test("setTuneAssignment creates assignment", async () => {
    const tuneId = await insertTune({ gameId: "fm-2023", name: "T", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    await setTuneAssignment("fm-2023", 100, 500, tuneId);
    const assignment = await getTuneAssignment("fm-2023", 100, 500);
    expect(assignment).not.toBeNull();
    expect(assignment!.tuneId).toBe(tuneId);
  });

  test("setTuneAssignment upserts on same car+track", async () => {
    const id1 = await insertTune({ gameId: "fm-2023", name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = await insertTune({ gameId: "fm-2023", name: "T2", author: "t", carOrdinal: 100, category: "wet", description: "", settings: TEST_SETTINGS });
    await setTuneAssignment("fm-2023", 100, 500, id1);
    await setTuneAssignment("fm-2023", 100, 500, id2);
    const assignment = await getTuneAssignment("fm-2023", 100, 500);
    expect(assignment!.tuneId).toBe(id2);
  });

  test("setTuneAssignment scopes by gameId — same car+track, different games coexist", async () => {
    const id1 = await insertTune({ gameId: "fm-2023", name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = await insertTune({ gameId: "acc", name: "T2", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    await setTuneAssignment("fm-2023", 100, 500, id1);
    await setTuneAssignment("acc", 100, 500, id2);
    expect((await getTuneAssignment("fm-2023", 100, 500))!.tuneId).toBe(id1);
    expect((await getTuneAssignment("acc", 100, 500))!.tuneId).toBe(id2);
  });

  test("deleteTuneAssignment removes assignment", async () => {
    const tuneId = await insertTune({ gameId: "fm-2023", name: "T", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    await setTuneAssignment("fm-2023", 100, 500, tuneId);
    expect(await deleteTuneAssignment("fm-2023", 100, 500)).toBe(true);
    expect(await getTuneAssignment("fm-2023", 100, 500)).toBeNull();
  });

  test("getTuneAssignments filters by carOrdinal", async () => {
    const id1 = await insertTune({ gameId: "fm-2023", name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = await insertTune({ gameId: "fm-2023", name: "T2", author: "t", carOrdinal: 200, category: "circuit", description: "", settings: TEST_SETTINGS });
    await setTuneAssignment("fm-2023", 100, 500, id1);
    await setTuneAssignment("fm-2023", 200, 600, id2);
    const all = await getTuneAssignments();
    expect(all.length).toBe(2);
    const filtered = await getTuneAssignments({ carOrdinal: 100 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].tuneName).toBe("T1");
  });

  test("getTuneAssignments filters by gameId", async () => {
    const id1 = await insertTune({ gameId: "fm-2023", name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = await insertTune({ gameId: "acc", name: "T2", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    await setTuneAssignment("fm-2023", 100, 500, id1);
    await setTuneAssignment("acc", 100, 500, id2);
    const filtered = await getTuneAssignments({ gameId: "acc" });
    expect(filtered.length).toBe(1);
    expect(filtered[0].tuneName).toBe("T2");
  });
});
