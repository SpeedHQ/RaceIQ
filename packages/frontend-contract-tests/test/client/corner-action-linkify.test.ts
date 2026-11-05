import { describe, expect, test } from "bun:test";
import { linkifyCornerActions } from "client/src/components/ai-chat/corner-action-linkify";
import type { CornerAction } from "@raceiq/lap-replay/contracts";

const action = (id: string, start: number, end: number, label = "T1"): CornerAction => ({
  id,
  cornerKey: "t1",
  label,
  target: "solo",
  span: { start, end },
});

describe("chat corner action linkifier", () => {
  test("wraps exactly the validated spans and leaves surrounding Markdown untouched", () => {
    const text = "- Brake later into T10, then T1.";
    expect(linkifyCornerActions(text, [action("a10", 19, 22, "T10 · Hairpin"), action("a1", 29, 31)])).toBe(
      "- Brake later into [T10 · Hairpin](#corner-action-a10), then [T1](#corner-action-a1).",
    );
  });

  test("skips out-of-range and overlapping actions without dropping the prose", () => {
    const text = "Turn 1 and Turn 2";
    expect(linkifyCornerActions(text, [action("bad", 40, 42), action("first", 0, 6, "Turn 1"), action("overlap", 3, 8)])).toBe(
      "[Turn 1](#corner-action-first) and Turn 2",
    );
  });
});
