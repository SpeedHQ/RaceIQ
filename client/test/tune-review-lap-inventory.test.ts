import { describe, expect, test } from "bun:test";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { tuneReviewLapInventory } from "../src/components/tunes/review/TuneReviewDashboard";
import { semanticSamples } from "../src/components/tunes/semantic-tune";
import type { SemanticReplayFrame } from "../src/hooks/laps";

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

  test("excludes stale semantic values while retaining freshness evidence", () => {
    const frames: SemanticReplayFrame[] = [
      {
        sequence: 1,
        observedAt: { domain: "session", milliseconds: 10 },
        receivedAt: { domain: "session", milliseconds: 10 },
        simulator: "acc",
        values: [
          { semanticId: "motion.speed", value: 50, state: "ok", freshness: "stale" },
          { semanticId: "inputs.accel", value: 128, state: "ok", freshness: "fresh" },
        ],
      },
    ];
    const [resolved] = semanticSamples(frames);
    expect(resolved.values["motion.speed"]).toBeUndefined();
    expect(resolved.freshness["motion.speed"]).toBe("stale");
    expect(resolved.values["inputs.accel"]).toBe(128);
  });
});
