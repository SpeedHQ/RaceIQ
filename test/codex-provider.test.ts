import { describe, expect, test } from "bun:test";

import { parseCodexJsonl } from "../server/ai/providers";
import { loadSettings } from "../server/settings";
import { getConfiguredAiProvider } from "../server/ai/provider-runtime";

describe("parseCodexJsonl", () => {
  test("extracts final agent message and usage from JSONL events", () => {
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7 } }),
    ].join("\n");

    expect(parseCodexJsonl(raw)).toEqual({
      text: "final answer",
      model: "codex",
      inputTokens: 12,
      outputTokens: 7,
    });
  });

  test("rejects output without a final agent message", () => {
    expect(() => parseCodexJsonl(JSON.stringify({ type: "thread.started" }))).toThrow("empty response");
  });
});

test("settings-aware runtime selects Codex without API-key lookup", async () => {
  const settings = { ...loadSettings(), aiProvider: "codex" as const, aiModel: "gpt-5" };
  await expect(getConfiguredAiProvider("analysis", settings)).resolves.toMatchObject({
    provider: "codex",
    model: "gpt-5",
  });
});
