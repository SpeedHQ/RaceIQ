import { expect, test } from "bun:test";
import { renderLapTime, renderOpponentLapPace, renderOpponentPace, renderOpponentPaceText, renderPreviewLine } from "../../server/live-strategy/live-engineer-renderer";

test("renders compound v3 pace and lap recipes", () => {
  const base = { relation: "within-class-pace" as const, scope: "class" as const, playerLapNumber: 1, playerLapTimeMs: 60_400, benchmarkLapTimeMs: 60_000, deltaMs: 400, benchmarkKind: "session-best" as const };
  expect(renderOpponentPaceText(base)).toBe("You are point four seconds from class pace.");
  expect(renderOpponentPace(base).segmentIds).toEqual(["pace.lead.you-are", "number.tenth.4", "pace.tail.seconds-from-class"]);
  expect(renderOpponentPace({ ...base, deltaMs: 1000 }, { voiceMode: "exact-response" }).segmentIds).toEqual(["pace.lead.you-are", "number.integer.1", "pace.tail.second-from-class"]);
  expect(renderOpponentLapPace({ ...base, deltaMs: 0 })).toMatchObject({ text: "Same pace as opponent last lap.", segmentIds: ["opponent-lap.same-pace"] });
  expect(renderLapTime(92_417)).toMatchObject({ text: "Your lap was one thirty two point four.", segmentIds: ["lap.lead.your-lap-was", "lap.body.1-32", "lap.tenth.4"] });
  expect(renderLapTime(59_950)).toMatchObject({ text: "Your lap was one minute flat.", segmentIds: ["lap.lead.your-lap-was", "lap.body.1-00", "lap.tail.flat"] });
  expect(renderLapTime(0).segmentIds).toEqual([]);
});

test("preserves fixed developer preview lines", () => {
  expect(renderPreviewLine("tires-cold")).toEqual({ lineId: "tires-cold", text: "Tires are cold. Be careful." });
  expect(renderPreviewLine("tires-optimal")).toEqual({ lineId: "tires-optimal", text: "Tires are optimal." });
  expect(renderPreviewLine("pit-this-lap")).toEqual({ lineId: "pit-this-lap", text: "Pit this lap." });
  expect(renderPreviewLine("pit-pit-pit")).toEqual({ lineId: "pit-pit-pit", text: "Pit pit pit." });
});
