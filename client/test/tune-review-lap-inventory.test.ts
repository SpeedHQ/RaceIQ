import { describe, expect, test } from "bun:test";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { tuneReviewLapInventory } from "../src/components/tunes/review/TuneReviewDashboard";

function lap(id: number, overrides: Partial<LapMeta> = {}): LapMeta {
  return {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime: 90 + id,
    isValid: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as LapMeta;
}

describe("Tune Review lap inventory", () => {
  test("keeps every inspectable lap and sorts newest first", () => {
    const laps = [lap(1), lap(2, { experimentExcluded: true, experimentExcludedSource: "manual" }), lap(3, { isValid: false, invalidReason: "off-track" }), lap(4), lap(5), lap(6), lap(7)];

    expect(tuneReviewLapInventory(laps).map(({ id }) => id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(laps.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
