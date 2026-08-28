import { expect, test } from "bun:test";
import { scenarioVoiceText } from "../src/components/dev/DevRaceEngineerSpeechPanel";

test("scenario voice text preserves highest-priority special state", () => {
  expect(scenarioVoiceText(["opponent-behind", "lap-invalidated", "damage-detected"])).toEqual({
    state: "opponent-behind",
    text: "Opponent behind.",
  });
});
