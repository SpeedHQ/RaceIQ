import { expect, test } from "bun:test";
import { scenarioVoiceText } from "../src/components/dev/DevRaceEngineerSpeechPanel";

test("scenario voice text preserves highest-priority special state", () => {
  expect(scenarioVoiceText(["opponent-behind", "lap-invalidated", "damage-detected"])).toEqual({
    state: "opponent-behind",
    text: "Opponent behind.",
  });
});

test("scenario voice text exposes fuel thresholds and pit urgency lines", () => {
  expect(scenarioVoiceText(["fuel-low"])).toEqual({
    state: "fuel-low",
    text: "Fuel is low.",
  });
  expect(scenarioVoiceText(["fuel-critical", "fuel-low"])).toEqual({
    state: "fuel-critical",
    text: "Fuel is critical.",
  });
  expect(scenarioVoiceText(["pit-this-lap"])).toEqual({
    state: "pit-this-lap",
    text: "Pit this lap.",
    lineId: "pit-this-lap",
  });
  expect(scenarioVoiceText(["pit-pit-pit"])).toEqual({
    state: "pit-pit-pit",
    text: "Pit pit pit.",
    lineId: "pit-pit-pit",
  });
});
