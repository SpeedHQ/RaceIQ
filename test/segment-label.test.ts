import { describe, test, expect } from "bun:test";
import { formatTurnNumbers, segmentDisplayNames, segmentGroupLabels } from "../client/src/lib/segment-label";

const corner = (name: string, numbers?: number[], group?: string) => ({
  type: "corner" as const,
  name,
  number: numbers?.[0],
  covers: numbers?.slice(1),
  ...(group ? { group } : {}),
});
const straight = (name = "", group?: string) => ({
  type: "straight" as const,
  name,
  ...(group ? { group } : {}),
});

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
    ).toEqual(["T1 La Source", "T2-4 Eau Rouge/Raidillon", "T10-11 Pouhon"]);
  });

  test("extends an auto T-token instead of repeating its number", () => {
    expect(segmentDisplayNames([corner("T6", [6]), corner("T8", [8, 9])])).toEqual(["T6", "T8-9"]);
  });

  test("numbers straights sequentially, keeping real straight names", () => {
    expect(segmentDisplayNames([straight(), corner("La Source", [1]), straight("Kemmel"), straight()])).toEqual([
      "S1",
      "T1 La Source",
      "Kemmel",
      "S3",
    ]);
  });

  test("falls back to the bare name when a corner has no turn numbers", () => {
    // Auto-detected (uncurated) tracks ship segments without numbers[].
    expect(segmentDisplayNames([corner("T1"), corner("T2")])).toEqual(["T1", "T2"]);
  });
});

describe("segmentDisplayNames — separate corner and straight counters", () => {
  const blank = (type: "corner" | "straight") => ({ type, name: "" });

  test("counts corners and straights on their own sequences", () => {
    expect(segmentDisplayNames([blank("straight"), blank("corner"), blank("straight"), blank("corner")])).toEqual(["S1", "T1", "S2", "T2"]);
  });

  test("names the editor's fresh placeholders instead of echoing them", () => {
    expect(segmentDisplayNames([{ type: "corner", name: "T?" }, { type: "straight", name: "S?" }])).toEqual(["T1", "S1"]);
  });

  test("an official turn number always wins over the positional counter", () => {
    // T6 is the sixth turn of the circuit even if it's the second segment the
    // detector placed — positional numbering must not overwrite a real number.
    expect(segmentDisplayNames([blank("corner"), corner("T6", [6])])).toEqual(["T1", "T6"]);
  });

  test("a bare T<n> token keeps its number rather than being repositioned", () => {
    expect(segmentDisplayNames([blank("straight"), corner("T4")])).toEqual(["S1", "T4"]);
  });
});

describe("numbered corner with no name", () => {
  test("renders the bare token, not a trailing space", () => {
    expect(segmentDisplayNames([corner("", [1])])).toEqual(["T1"]);
    expect(segmentDisplayNames([corner("", [7, 8])])).toEqual(["T7-8"]);
  });
});
