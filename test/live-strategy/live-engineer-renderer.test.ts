import { expect, test } from "bun:test";
import { lapTimeAtoms, numberAtoms, renderOpponentPaceText } from "../../server/live-strategy/live-engineer-renderer";

test("renders fixed v1 wording and number atoms", () => {
  expect(renderOpponentPaceText({ relation: "fastest-in-class", scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_000, benchmarkLapTimeMs: 61_000, deltaMs: -1_000, benchmarkKind: "session-best" })).toBe("Fastest in class.");
  expect(numberAtoms(32.3)).toEqual(["thirty", "two", "point", "three"]);
  expect(lapTimeAtoms(92_417)).toEqual(["one", "minute", "thirty", "two", "point", "four", "one", "seven"]);
});
