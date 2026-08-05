import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { buildInputsComparePrompt } from "../../../server/ai/inputs-compare-prompt";

initGameAdapters();
initServerGameAdapters();

const trace = {
  elapsedTime: [0, 0.5, 1],
  throttle: [0, 0.5, 1],
  brake: [0, 0.2, 0],
  steer: [127, 130, 127],
  speed: [10, 15, 20],
  fuel: [1, 0.99, 0.98],
  tireWear: [0, 0.01, 0.02],
  rpm: [1000, 2000, 3000],
  gear: [1, 2, 3],
  posX: [0, 0, 0],
  posZ: [0, 0, 0],
};

const comparison = {
  distances: [0, 5, 10],
  lapA: trace,
  lapB: trace,
  timeDelta: [0, 0.01, 0.02],
  cornerDeltas: [],
};

describe("inputs compare prompt", () => {
  test("builds prompt with supplied track guide", () => {
    const prompt = buildInputsComparePrompt(
      { lapNumber: 1, lapTime: 1, isValid: true },
      { lapNumber: 2, lapTime: 1.02, isValid: true },
      comparison,
      [{ name: "Turn 1", type: "corner", startFrac: 0, endFrac: 1 }],
      "\n--- Expert Track Guide ---\nBrake before Turn 1.",
    );

    expect(prompt).toContain("Brake before Turn 1.");
    expect(prompt).toContain("[Turn 1]");
  });
});
