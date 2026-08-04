import { describe, expect, test } from "bun:test";
import { buildCompareChatSystemPrompt } from "../server/ai/compare-chat-prompt";

describe("compare chat initialization prompt", () => {
  test("requires all comparison tools before any response", () => {
    const prompt = buildCompareChatSystemPrompt(
      { id: 13, lapNumber: 1, lapTime: 97.932, isValid: true },
      { id: 14, lapNumber: 2, lapTime: 98.706, isValid: false },
      {
        timeDelta: [0, 0.004],
        distances: [0, 2178],
        cornerDeltas: [],
      } as any,
    );

    expect(prompt).toContain("INITIALIZATION PROTOCOL");
    expect(prompt).toContain("Do not answer, acknowledge, greet, or explain");
    expect(prompt).toContain("`get_lap_analysis` with `lapId: 13`");
    expect(prompt).toContain("`get_lap_analysis` with `lapId: 14`");
    expect(prompt).toContain(
      "`get_compare_analysis` with `lapAId: 13` and `lapBId: 14`",
    );
    expect(prompt.indexOf("`get_lap_analysis` with `lapId: 13`")).toBeLessThan(
      prompt.indexOf("`get_lap_analysis` with `lapId: 14`"),
    );
    expect(prompt.indexOf("`get_lap_analysis` with `lapId: 14`")).toBeLessThan(
      prompt.indexOf(
        "`get_compare_analysis` with `lapAId: 13` and `lapBId: 14`",
      ),
    );
    expect(prompt).toContain("Never claim a tool was called unless its tool result exists");
  });
});
