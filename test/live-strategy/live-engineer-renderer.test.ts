import { expect, test } from "bun:test";
import { lapTimeAtoms, numberAtoms, renderOpponentLapPace, renderOpponentPaceText, renderPreviewLine } from "../../server/live-strategy/live-engineer-renderer";

test("renders user-facing pace wording and number atoms", () => {
  expect(renderOpponentPaceText({ relation: "fastest-in-class", scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_000, benchmarkLapTimeMs: 61_000, deltaMs: -1_000, benchmarkKind: "session-best" })).toBe("Fastest in class.");
  expect(renderOpponentPaceText({ relation: "setting-race-pace", scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_000, benchmarkLapTimeMs: 61_000, deltaMs: -1_000, benchmarkKind: "session-best" })).toBe("You are setting the current race pace.");
  expect(renderOpponentLapPace({ relation: "within-class-pace", scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_400, benchmarkLapTimeMs: 60_000, deltaMs: 400, benchmarkKind: "session-best" })).toMatchObject({
    text: "Opponent was point four seconds faster last lap.",
    segmentIds: ["phrase.opponent-was", "number.point", "number.four", "unit.seconds", "phrase.faster-last-lap"],
  });
  expect(renderOpponentLapPace({ relation: "within-class-pace", scope: "class", playerLapNumber: 1, playerLapTimeMs: 59_600, benchmarkLapTimeMs: 60_000, deltaMs: -400, benchmarkKind: "session-best" })).toMatchObject({
    text: "You were point four seconds faster last lap.",
    segmentIds: ["phrase.you-were", "number.point", "number.four", "unit.seconds", "phrase.faster-last-lap"],
  });
  expect(renderOpponentLapPace({ relation: "within-class-pace", scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_000, benchmarkLapTimeMs: 60_000, deltaMs: 0, benchmarkKind: "session-best" })).toMatchObject({
    text: "Same pace as opponent last lap.",
    segmentIds: ["phrase.same-pace-last-lap"],
  });
  expect(renderPreviewLine("tires-cold")).toEqual({ lineId: "tires-cold", text: "Tires are cold. Be careful." });
  expect(renderPreviewLine("tires-optimal")).toEqual({ lineId: "tires-optimal", text: "Tires are optimal." });
  expect(renderPreviewLine("pit-this-lap")).toEqual({ lineId: "pit-this-lap", text: "Pit this lap." });
  expect(renderPreviewLine("pit-pit-pit")).toEqual({ lineId: "pit-pit-pit", text: "Pit pit pit." });
  expect(renderOpponentPaceText({ relation: "within-class-pace", scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_000, benchmarkLapTimeMs: 300, deltaMs: 300, benchmarkKind: "session-best" })).toBe("You are point three seconds from class pace.");
  expect(numberAtoms(0.3)).toEqual(["point", "three"]);
  expect(numberAtoms(32.3)).toEqual(["thirty", "two", "point", "three"]);
  expect(lapTimeAtoms(92_417)).toEqual(["one", "minute", "thirty", "two", "point", "four", "one", "seven"]);
});
