import { describe, test, expect } from "bun:test";
import {
  fastestLaps,
  selectEvaluationLaps,
  evaluationReasonLabel,
  REVIEW_LAP_CAP,
} from "../shared/laps/review-selection";

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

describe("selectEvaluationLaps", () => {
  const lap = (id: number, lapTime: number, over: Partial<Parameters<typeof selectEvaluationLaps>[0][number]> = {}) => ({
    id,
    lapTime,
    isValid: true,
    invalidReason: null,
    ...over,
  });

  test("chooses the fastest N clean laps, rest are slower-than-cap", () => {
    const laps = [lap(1, 95), lap(2, 91), lap(3, 93), lap(4, 99)];
    const sel = selectEvaluationLaps(laps, 2);
    expect(sel.chosen.map((l) => l.id)).toEqual([2, 3]);
    expect([...sel.chosenIds].sort()).toEqual([2, 3]);
    expect([...sel.cappedIds].sort()).toEqual([1, 4]);
    expect(sel.reasonById.get(2)).toBe("chosen");
    expect(sel.reasonById.get(1)).toBe("slower-than-cap");
  });

  test("manual exclusion wins over every other reason", () => {
    const laps = [
      lap(1, 90, { isValid: false, experimentExcluded: true, experimentExcludedSource: "manual" }),
      lap(2, 92),
    ];
    const sel = selectEvaluationLaps(laps);
    expect(sel.reasonById.get(1)).toBe("manual");
    expect(sel.chosenIds.has(1)).toBe(false);
  });

  test("a manual source that is not excluded stays a candidate", () => {
    const laps = [lap(1, 90, { experimentExcluded: false, experimentExcludedSource: "manual" })];
    const sel = selectEvaluationLaps(laps);
    expect(sel.reasonById.get(1)).toBe("chosen");
  });

  test("invalid, non-positive time and pit laps are ineligible", () => {
    const laps = [
      lap(2, 90, { isValid: false }),
      lap(3, 0),
      lap(4, 90, { invalidReason: "inlap" }),
      lap(5, 94),
    ];
    const sel = selectEvaluationLaps(laps);
    expect(sel.reasonById.get(2)).toBe("invalid");
    expect(sel.reasonById.get(3)).toBe("invalid");
    expect(sel.reasonById.get(4)).toBe("pit");
    expect(sel.chosen.map((l) => l.id)).toEqual([5]);
    expect(sel.cappedIds.size).toBe(0);
  });

  test("a capped lap already stamped by the auto pass reports source auto", () => {
    const laps = [lap(1, 90), lap(2, 95, { experimentExcluded: true, experimentExcludedSource: "auto" })];
    const sel = selectEvaluationLaps(laps, 1);
    expect(sel.reasonById.get(2)).toBe("auto");
    expect(sel.cappedIds.has(2)).toBe(true);
  });

  test("auto stamping never keeps a lap out of the chosen set", () => {
    // Stale auto-exclude state must lose to a fresh fastest-N ranking.
    const laps = [lap(1, 90, { experimentExcluded: true, experimentExcludedSource: "auto" }), lap(2, 99)];
    const sel = selectEvaluationLaps(laps, 1);
    expect(sel.chosen.map((l) => l.id)).toEqual([1]);
    expect(sel.reasonById.get(1)).toBe("chosen");
  });

  test("every lap gets exactly one reason", () => {
    const laps = [lap(1, 90), lap(2, 91, { isValid: false }), lap(3, 92)];
    const sel = selectEvaluationLaps(laps, 1);
    expect(sel.reasonById.size).toBe(laps.length);
    for (const l of laps) expect(evaluationReasonLabel(sel.reasonById.get(l.id)!)).toBeTruthy();
  });

  test("empty input yields an empty selection", () => {
    const sel = selectEvaluationLaps([]);
    expect(sel.chosen).toEqual([]);
    expect(sel.reasonById.size).toBe(0);
  });
});
