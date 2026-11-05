import { describe, expect, test } from "bun:test";

import { baseUrlFor } from "./provider-endpoints";

describe("baseUrlFor — fixed endpoint per provider", () => {
  test("deepseek uses its official OpenAI-compatible endpoint", () => {
    expect(baseUrlFor("deepseek")).toBe("https://api.deepseek.com");
  });

  test("openai uses its official endpoint", () => {
    expect(baseUrlFor("openai")).toBe("https://api.openai.com/v1");
  });

  test("openai-compatible has no fixed endpoint (the user provides one)", () => {
    expect(baseUrlFor("openai-compatible")).toBeUndefined();
  });

  test("gemini does not go through the OpenAI-compatible layer", () => {
    expect(baseUrlFor("gemini")).toBeUndefined();
  });
});
