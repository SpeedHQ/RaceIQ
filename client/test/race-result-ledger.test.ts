import { describe, expect, test } from "bun:test";
import { buildRaceResultTimeline, formatService } from "../src/components/race-results/RaceResultLedger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMeta } from "@shared/racing/sessions/types";
import { SessionResultMeta } from "../src/components/sessions/SessionResultMeta";
const result = {
  id: 1,
  sessionId: 7,
  gameId: "f1-2025",
  processorVersion: "race-result-v1",
  sessionType: "race",
  classification: "finished",
  finishingPosition: 2,
  isPodium: true,
  isFastestLap: false,
  qualifyingPosition: 5,
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
  test("hides stale LMU practice positions while retaining pit activity", () => {
    const timeline = buildRaceResultTimeline({
      ...result, gameId: "lmu", sessionType: "practice",
      events: [
        { ...result.events[0], eventType: "position-change", sequence: 1, positionAfter: 2 },
        { ...result.events[0], sequence: 2 },
      ],
    });
    expect(timeline.map((node) => node.kind)).toEqual(["start", "pit", "finish"]);
    expect(timeline[0]).toMatchObject({ position: null });
    expect(timeline[2]).toMatchObject({ finishingPosition: null });
  });

  test("never labels LMU practice or test day as a race result position", () => {
    for (const sessionType of ["practice-1", "test-day"]) {
      const session = { gameId: "lmu", sessionType, finishingPosition: 1 } as SessionMeta;
      const markup = renderToStaticMarkup(createElement(SessionResultMeta, { session }));
      expect(markup).not.toMatch(/P\d/);
    }
    const race = { gameId: "lmu", sessionType: "race", finishingPosition: 1 } as SessionMeta;
    expect(renderToStaticMarkup(createElement(SessionResultMeta, { session: race }))).toMatch(/P<!-- -->1|P1/);
  });

  test("places qualifying before start, race events, and finish", () => {
    const timeline = buildRaceResultTimeline(result);
    expect(timeline.map((node) => node.kind)).toEqual(["qualifying", "start", "pit", "finish"]);
    expect(timeline[0]).toMatchObject({ kind: "qualifying", position: 5 });
    expect(timeline[1]).toMatchObject({ kind: "start", position: 5 });
    expect(timeline[2]).toMatchObject({ lapNumber: 12, service: "tyres" });
    expect(timeline[3]).not.toHaveProperty("qualifyingPosition");
  });

  test("places penalty event in sequence without treating it as a pit stop", () => {
    const timeline = buildRaceResultTimeline({
      ...result,
      events: [
        { ...result.events[0], eventType: "penalty", sequence: 2, lapNumber: 8, service: "unknown", source: { penalty: 2, penaltyType: "drive-through", penaltyTime: 30 } },
        { ...result.events[0], eventType: "position-change", sequence: 1, service: "unknown", positionBefore: 5, positionAfter: 4 },
        { ...result.events[0], sequence: 3 },
      ],
    });
    expect(timeline.map((node) => node.kind)).toEqual(["qualifying", "start", "position", "penalty", "pit", "finish"]);
    expect(timeline[3]).toMatchObject({ kind: "penalty", sequence: 2, lapNumber: 8, penaltyType: "drive through", penaltyTime: 30 });
  });


  test("keeps start and finish when no pit events exist", () => {
    expect(buildRaceResultTimeline({ ...result, events: [] }).map((node) => node.kind)).toEqual(["qualifying", "start", "finish"]);
  });

  test("omits qualifying when starting position is unknown", () => {
    const timeline = buildRaceResultTimeline({ ...result, qualifyingPosition: null, events: [] });
    expect(timeline.map((node) => node.kind)).toEqual(["start", "finish"]);
    expect(timeline[0]).toMatchObject({ kind: "start", position: null });
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
    expect(timeline[2]).toMatchObject({ kind: "position", lapNumber: 4, direction: "up", position: 3 });
  });

  test("does not show a false transition back to grid position", () => {
    const timeline = buildRaceResultTimeline({
      ...result,
      qualifyingPosition: 3,
      events: [
        {
          ...result.events[0],
          eventType: "position-change",
          service: "unknown",
          lapNumber: 4,
          positionBefore: 2,
          positionAfter: 3,
        },
      ],
    });
    expect(timeline.map((node) => node.kind)).toEqual(["qualifying", "start", "finish"]);
  });
  test("omits null optional event values", () => {
    const [pit] = buildRaceResultTimeline({ ...result, events: [{ ...result.events[0], lapNumber: null, durationSeconds: null, tyreChange: null }] }).filter((node) => node.kind === "pit");
    expect(pit).toMatchObject({ lapNumber: null, durationSeconds: null, tyreChange: null });
  });
  test("labels unknown pit service as Pit", () => {
    expect(formatService("unknown")).toBe("Pit");
  });
});
