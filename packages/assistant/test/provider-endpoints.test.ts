import { describe, expect, test } from "bun:test";

import { baseUrlFor } from "@raceiq/assistant/ai/provider-endpoints";

describe("baseUrlFor — fixed provider endpoints", () => {
  test("DeepSeek uses its official OpenAI-compatible endpoint", () => {
    expect(baseUrlFor("deepseek")).toBe("https://api.deepseek.com");
  });

  test("OpenAI uses its official endpoint", () => {
    expect(baseUrlFor("openai")).toBe("https://api.openai.com/v1");
  });

  test("OpenAI-compatible endpoints are user-configured", () => {
    expect(baseUrlFor("openai-compatible")).toBeUndefined();
  });

  test("Gemini does not use the OpenAI-compatible transport", () => {
    expect(baseUrlFor("gemini")).toBeUndefined();
  });
});
