import { describe, test, expect } from "bun:test";
import { formatTurnNumbers, segmentDisplayNames } from "../client/src/lib/segment-label";

const corner = (name: string, numbers?: number[]) => ({ type: "corner" as const, name, numbers });
const straight = (name = "") => ({ type: "straight" as const, name, numbers: undefined });

describe("formatTurnNumbers", () => {
  test("collapses a contiguous run into a range", () => {
    expect(formatTurnNumbers([2, 3, 4])).toBe("2-4");
  });
  test("renders a lone turn bare", () => {
    expect(formatTurnNumbers([1])).toBe("1");
  });
  test("lists non-contiguous turns", () => {
    expect(formatTurnNumbers([2, 4])).toBe("2,4");
  });
  test("sorts before formatting", () => {
    expect(formatTurnNumbers([4, 2, 3])).toBe("2-4");
  });
  test("empty stays empty", () => {
    expect(formatTurnNumbers([])).toBe("");
  });
});

describe("segmentDisplayNames", () => {
  test("names a corner with the turns it covers", () => {
    // Spa's real shape: a lone corner, a merged chicane, a double-apex.
    expect(
      segmentDisplayNames([corner("La Source", [1]), corner("Eau Rouge/Raidillon", [2, 3, 4]), corner("Pouhon", [10, 11])]),
    ).toEqual(["La Source (1)", "Eau Rouge/Raidillon (2-4)", "Pouhon (10-11)"]);
  });

  test("extends an auto T-token instead of repeating its number", () => {
    expect(segmentDisplayNames([corner("T6", [6]), corner("T8", [8, 9])])).toEqual(["T6", "T8-9"]);
  });

  test("numbers straights sequentially, keeping real straight names", () => {
    expect(segmentDisplayNames([straight(), corner("La Source", [1]), straight("Kemmel"), straight()])).toEqual([
      "S1",
      "La Source (1)",
      "Kemmel",
      "S3",
    ]);
  });

  test("falls back to the bare name when a corner has no turn numbers", () => {
    // Auto-detected (uncurated) tracks ship segments without numbers[].
    expect(segmentDisplayNames([corner("T1"), corner("T2")])).toEqual(["T1", "T2"]);
  });
});
