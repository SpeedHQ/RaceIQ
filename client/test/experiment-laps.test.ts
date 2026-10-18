import { describe, expect, test } from "bun:test";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { groupExperimentLaps, mergeExperimentLaps } from "../src/lib/experiment-laps";
import { selectEvaluationLaps } from "@raceiq/analysis-core/racing/laps/review-selection";

const tests = [
  { id: 11, version: 1, createdAt: "2026-10-01T10:00:00Z" },
  { id: 12, version: 2, createdAt: "2026-10-01T11:00:00Z" },
];
function lap(id: number, overrides: Partial<LapMeta> = {}): LapMeta {
  return { id, sessionId: 1, lapNumber: id, lapTime: 90, isValid: true, classification: null, carId: "1", trackId: "1", createdAt: "2026-10-01T12:00:00Z", experimentId: 7, experimentVersionId: 11, ...overrides };
}

describe("experiment lap membership", () => {
  test("keeps imported historical laps and later laps on the explicitly selected older test", () => {
    const laps = [lap(1, { createdAt: "2026-09-01T10:00:00Z" }), lap(2), lap(3, { experimentVersionId: 12 })];
    const groups = groupExperimentLaps(laps, tests);
    expect(groups.get(11)?.map((lap) => lap.id)).toEqual([1, 2]);
    expect(groups.get(12)?.map((lap) => lap.id)).toEqual([3]);
  });

  test("does not guess a test for unstamped or deleted-test laps", () => {
    const groups = groupExperimentLaps([lap(1, { experimentVersionId: null }), lap(2, { experimentVersionId: 99 })], tests);
    expect([...groups.keys()]).toEqual([]);
  });

  test("preserves stamped membership and manual exclusions when live metadata overlaps persisted laps", () => {
    const persisted = [lap(1), lap(2, { experimentExcluded: true, experimentExcludedSource: "manual" }), lap(3, { experimentVersionId: 12 })];
    const live = persisted.map((lap) => ({ ...lap, experimentId: undefined, experimentVersionId: undefined, experimentExcluded: undefined, experimentExcludedSource: undefined }));
    const pool = mergeExperimentLaps(persisted, live, 7);
    const groups = groupExperimentLaps(pool, tests);
    expect(groups.get(11)?.map((lap) => lap.id)).toEqual([1, 2]);
    expect(selectEvaluationLaps(groups.get(11) ?? []).chosen.map((lap) => lap.id)).toEqual([1]);
    expect(groups.get(12)?.map((lap) => lap.id)).toEqual([3]);
  });

  test("includes newly arrived live laps without importing known laps from another experiment", () => {
    const persisted = [lap(1, { experimentId: 8 }), lap(2)];
    const pool = mergeExperimentLaps(persisted, [
      lap(1, { experimentId: undefined, experimentVersionId: undefined }),
      lap(2, { experimentId: undefined, experimentVersionId: undefined }),
      lap(3),
      lap(4, { experimentId: undefined, experimentVersionId: undefined }),
      lap(5, { experimentId: 8 }),
    ], 7);
    expect(pool.map((lap) => lap.id)).toEqual([2, 3, 4]);
    expect(groupExperimentLaps(pool, tests).get(11)?.map((lap) => lap.id)).toEqual([2, 3]);
  });

  test("orders laps within each source session when lap numbers restart", () => {
    const groups = groupExperimentLaps([lap(1, { sessionId: 2, lapNumber: 1 }), lap(2, { sessionId: 1, lapNumber: 3 }), lap(3, { sessionId: 1, lapNumber: 2 })], tests);
    expect(groups.get(11)?.map((lap) => lap.id)).toEqual([3, 2, 1]);
  });

  test("honors a persisted test reassignment over contradictory live stamps", () => {
    const pool = mergeExperimentLaps([lap(1, { experimentVersionId: 12 }), lap(2)], [lap(1)], 7);
    const groups = groupExperimentLaps(pool, tests);
    expect(selectEvaluationLaps(groups.get(11) ?? []).chosen.map((lap) => lap.id)).toEqual([2]);
    expect(selectEvaluationLaps(groups.get(12) ?? []).chosen.map((lap) => lap.id)).toEqual([1]);
  });

  test("does not resurrect a detached lap from stale live membership", () => {
    const pool = mergeExperimentLaps([lap(1, { experimentId: null, experimentVersionId: null }), lap(2)], [lap(1)], 7);
    expect(pool.map((lap) => lap.id)).toEqual([2]);
    expect(groupExperimentLaps(pool, tests).get(11)?.map((lap) => lap.id)).toEqual([2]);
  });

  test("deduplicates repeated live events and ranks using the latest metadata", () => {
    const live = [lap(1, { lapTime: 80 }), lap(2, { lapTime: 81 }), lap(3, { lapTime: 82 }), lap(4, { lapTime: 83 }), lap(5, { lapTime: 84 }), lap(6, { lapTime: 85 }), lap(1, { lapTime: 100 })];
    const pool = mergeExperimentLaps([], live, 7);
    expect(pool.filter((lap) => lap.id === 1).map((lap) => lap.lapTime)).toEqual([100]);
    expect(selectEvaluationLaps(groupExperimentLaps(pool, tests).get(11) ?? []).chosen.map((lap) => lap.id)).toEqual([2, 3, 4, 5, 6]);
  });

  test("keeps the fastest-five cap within the selected test and excludes ineligible faster laps", () => {
    const pool = mergeExperimentLaps([
      lap(1, { lapTime: 95 }),
      lap(2, { lapTime: 94 }),
      lap(3, { lapTime: 93 }),
      lap(4, { lapTime: 92 }),
      lap(5, { lapTime: 91 }),
      lap(6, { lapTime: 90 }),
      lap(7, { lapTime: 70, experimentExcluded: true, experimentExcludedSource: "manual" }),
      lap(8, { lapTime: 60, isValid: false }),
      lap(9, { lapTime: 50, invalidReason: "outlap" }),
      lap(10, { lapTime: 40, experimentVersionId: 12 }),
    ], [], 7);
    const groups = groupExperimentLaps(pool, tests);
    expect(selectEvaluationLaps(groups.get(11) ?? []).chosen.map((lap) => lap.id)).toEqual([6, 5, 4, 3, 2]);
    expect(selectEvaluationLaps(groups.get(12) ?? []).chosen.map((lap) => lap.id)).toEqual([10]);
  });

  test("restores evaluation after undoing manual exclusion despite stale live flags", () => {
    const pool = mergeExperimentLaps([lap(1, { lapTime: 80, experimentExcluded: false, experimentExcludedSource: null }), lap(2)], [
      lap(1, { experimentExcluded: true, experimentExcludedSource: "manual" }),
    ], 7);
    expect(selectEvaluationLaps(groupExperimentLaps(pool, tests).get(11) ?? []).chosen.map((lap) => lap.id)).toEqual([1, 2]);
  });

  test("produces no evaluation laps when every member is invalid, manually excluded, or a pit-cycle lap", () => {
    const groups = groupExperimentLaps([
      lap(1, { isValid: false }),
      lap(2, { experimentExcluded: true, experimentExcludedSource: "manual" }),
      lap(3, { invalidReason: "inlap" }),
      lap(4, { invalidReason: "pit lap" }),
      lap(5, { lapTime: 0 }),
    ], tests);
    expect(selectEvaluationLaps(groups.get(11) ?? []).chosen.map((lap) => lap.id)).toEqual([]);
  });
});
