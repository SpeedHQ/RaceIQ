import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../server/db/index";
import { tunes, tuneAssignments } from "../server/db/schema";
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
  updateLapTune,
} from "../server/db/tune-queries";

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

beforeEach(() => {
  db.delete(tuneAssignments).run();
  db.delete(tunes).run();
});

describe("tune CRUD", () => {
  test("insertTune creates and returns tune with id", () => {
    const id = insertTune({
      name: "Test Tune",
      author: "tester",
      carOrdinal: 2860,
      category: "circuit",
      description: "A test tune",
      settings: TEST_SETTINGS,
    });
    expect(id).toBeGreaterThan(0);
  });

  test("getTuneById returns inserted tune", () => {
    const id = insertTune({
      name: "Test Tune",
      author: "tester",
      carOrdinal: 2860,
      category: "circuit",
      description: "A test tune",
      settings: TEST_SETTINGS,
    });
    const tune = getTuneById(id);
    expect(tune).not.toBeNull();
    expect(tune!.name).toBe("Test Tune");
    expect(tune!.carOrdinal).toBe(2860);
  });

  test("getTunes filters by carOrdinal", () => {
    insertTune({ name: "A", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    insertTune({ name: "B", author: "t", carOrdinal: 200, category: "wet", description: "", settings: TEST_SETTINGS });
    const filtered = getTunes(100);
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("A");
  });

  test("updateTune modifies fields", () => {
    const id = insertTune({ name: "Old", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const updated = updateTune(id, { name: "New" });
    expect(updated).toBe(true);
    expect(getTuneById(id)!.name).toBe("New");
  });

  test("deleteTune removes tune", () => {
    const id = insertTune({ name: "X", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    expect(deleteTune(id)).toBe(true);
    expect(getTuneById(id)).toBeNull();
  });
});

describe("tune assignments", () => {
  test("setTuneAssignment creates assignment", () => {
    const tuneId = insertTune({ name: "T", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, tuneId);
    const assignment = getTuneAssignment(100, 500);
    expect(assignment).not.toBeNull();
    expect(assignment!.tuneId).toBe(tuneId);
  });

  test("setTuneAssignment upserts on same car+track", () => {
    const id1 = insertTune({ name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = insertTune({ name: "T2", author: "t", carOrdinal: 100, category: "wet", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, id1);
    setTuneAssignment(100, 500, id2);
    const assignment = getTuneAssignment(100, 500);
    expect(assignment!.tuneId).toBe(id2);
  });

  test("deleteTuneAssignment removes assignment", () => {
    const tuneId = insertTune({ name: "T", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, tuneId);
    expect(deleteTuneAssignment(100, 500)).toBe(true);
    expect(getTuneAssignment(100, 500)).toBeNull();
  });

  test("getTuneAssignments filters by carOrdinal", () => {
    const id1 = insertTune({ name: "T1", author: "t", carOrdinal: 100, category: "circuit", description: "", settings: TEST_SETTINGS });
    const id2 = insertTune({ name: "T2", author: "t", carOrdinal: 200, category: "circuit", description: "", settings: TEST_SETTINGS });
    setTuneAssignment(100, 500, id1);
    setTuneAssignment(200, 600, id2);
    const all = getTuneAssignments();
    expect(all.length).toBe(2);
    const filtered = getTuneAssignments(100);
    expect(filtered.length).toBe(1);
    expect(filtered[0].tuneName).toBe("T1");
  });
});
