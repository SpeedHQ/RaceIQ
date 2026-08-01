import { describe, expect, test } from "bun:test";
import { compareSegmentKey } from "../client/src/components/comparison/CompareTrackMap";

describe("compareSegmentKey", () => {
  test("distinguishes repeated display names by segment position", () => {
    const keys = [
      compareSegmentKey("Start/Finish", 0, 0.1),
      compareSegmentKey("Start/Finish", 0.9, 1),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
