import { describe, expect, test } from "bun:test";
import { buildRaceResultTimeline } from "../src/components/race-results/RaceResultLedger";

const result = {
  id: 1,
  sessionId: 7,
  gameId: "f1-2025",
  processorVersion: "race-result-v1",
  sessionType: "race",
  classification: "finished",
  finishingPosition: 2,
  qualifyingPosition: null,
  isPodium: true,
  isFastestLap: false,
  pitCount: 1,
  tyreStrategy: null,
  fuelStrategy: null,
  provenance: null,
  reasons: [],
  events: [
    {
      sequence: 1,
      lapNumber: 12,
      elapsedSeconds: 900,
      durationSeconds: 22.4,
      service: "tyres",
      tyreChange: { to: "soft" },
      fuelAdded: null,
      fuelBefore: null,
      fuelAfter: null,
      linkage: "linked",
      source: null,
    },
  ],
} as const;

describe("race result timeline", () => {
  test("builds start, pit, and finish nodes in order", () => {
    expect(buildRaceResultTimeline(result).map((node) => node.kind)).toEqual(["start", "pit", "finish"]);
    expect(buildRaceResultTimeline(result)[1]).toMatchObject({ lapNumber: 12, service: "tyres" });
  });

  test("keeps start and finish when no pit events exist", () => {
    expect(buildRaceResultTimeline({ ...result, events: [] }).map((node) => node.kind)).toEqual(["start", "finish"]);
  });


  test("renders position-change events as position nodes", () => {
    const timeline = buildRaceResultTimeline({
      ...result,
      events: [
        {
          ...result.events[0],
          eventType: "position-change",
          service: "unknown",
          lapNumber: 4,
          positionBefore: 5,
          positionAfter: 3,
        },
      ],
    });
    expect(timeline[1]).toMatchObject({ kind: "position", lapNumber: 4, positionBefore: 5, positionAfter: 3 });
  });
  test("omits null optional event values", () => {
    const [pit] = buildRaceResultTimeline({ ...result, events: [{ ...result.events[0], lapNumber: null, durationSeconds: null, tyreChange: null }] }).filter((node) => node.kind === "pit");
    expect(pit).toMatchObject({ lapNumber: null, durationSeconds: null, tyreChange: null });
  });
});
