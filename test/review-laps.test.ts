import { describe, test, expect } from "bun:test";
import { fastestLaps, REVIEW_LAP_CAP } from "../shared/review-laps";

describe("fastestLaps", () => {
  const laps = [
    { id: 1, lapTime: 95.2 },
    { id: 2, lapTime: 92.1 },
    { id: 3, lapTime: 98.7 },
    { id: 4, lapTime: 91.0 },
    { id: 5, lapTime: 93.3 },
    { id: 6, lapTime: 90.5 },
    { id: 7, lapTime: 99.9 },
  ];

  test("returns the N fastest by lap time", () => {
    const out = fastestLaps(laps, 3);
    expect(out.map((l) => l.id)).toEqual([6, 4, 2]);
  });

  test("defaults to REVIEW_LAP_CAP", () => {
    expect(fastestLaps(laps).length).toBe(REVIEW_LAP_CAP);
    expect(REVIEW_LAP_CAP).toBe(5);
  });

  test("returns all when fewer than the cap, does not mutate input", () => {
    const few = [{ id: 1, lapTime: 90 }, { id: 2, lapTime: 91 }];
    const snapshot = [...few];
    expect(fastestLaps(few).map((l) => l.id)).toEqual([1, 2]);
    expect(few).toEqual(snapshot);
  });
});
