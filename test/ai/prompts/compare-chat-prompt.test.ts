import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { buildCompareChatContext, buildCompareChatSystemPrompt } from "../../../server/ai/compare-chat-prompt";

initGameAdapters();
initServerGameAdapters();

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

  test("includes database lap IDs in dynamic context", () => {
    const context = buildCompareChatContext(
      { id: 13, lapNumber: 1, lapTime: 97.932, isValid: true },
      { id: 14, lapNumber: 2, lapTime: 98.706, isValid: false },
      { timeDelta: [0, 0.004], distances: [0, 2178], cornerDeltas: [] } as any,
    );

    expect(context).toContain("Lap A ID: 13");
    expect(context).toContain("Lap B ID: 14");
  });

  test("resolves track and car names with lap game identity", () => {
    const context = buildCompareChatContext(
      { id: 13, lapNumber: 1, lapTime: 97.932, isValid: true, carOrdinal: 59, trackOrdinal: 2, gameId: "ac-evo" },
      { id: 14, lapNumber: 2, lapTime: 98.706, isValid: false, carOrdinal: 59, trackOrdinal: 2, gameId: "ac-evo" },
      { timeDelta: [0, 0.004], distances: [0, 2178], cornerDeltas: [] } as any,
    );

    expect(context).toContain("Track: Brands Hatch - GP");
    expect(context).toContain("Porsche 992 GT3 R Rennsport");
  });

  test("includes every deterministic segment delta", () => {
    const context = buildCompareChatContext(
      { id: 13, lapNumber: 1, lapTime: 97.932, isValid: true },
      { id: 14, lapNumber: 2, lapTime: 98.706, isValid: false },
      {
        distances: [0, 5, 10, 15, 20],
        timeDelta: [0, -1, 0, 1, 0],
        cornerDeltas: [],
        lapA: { elapsedTime: [0, 1, 2, 4, 5] },
        lapB: { elapsedTime: [0, 2, 3, 4, 5] },
      } as any,
      [
        { name: "First", type: "corner", startFrac: 0, endFrac: 0.5 },
        { name: "Second", type: "straight", startFrac: 0.5, endFrac: 1 },
      ],
    );

    expect(context).toContain("First*");
    expect(context).toContain("Second");
    expect(context).toContain("-1.000");
    expect(context).toContain("+1.000");
  });
});
