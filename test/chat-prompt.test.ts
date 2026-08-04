import { describe, expect, test } from "bun:test";
import { formatLapChatIdentity } from "../server/ai/chat-prompt";

describe("lap chat prompt", () => {
  test("exposes database lap ID separately from display lap number", () => {
    const identity = formatLapChatIdentity({
      id: 5,
      lapNumber: 2,
      lapTime: 79.328,
    });

    expect(identity).toContain("Lap ID: 5");
    expect(identity).toContain("Lap #2 — 79.328s");
  });
});

