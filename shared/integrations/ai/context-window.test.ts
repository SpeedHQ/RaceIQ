import { describe, expect, test } from "bun:test";

import { contextWindowFor } from "./context-window";

describe("contextWindowFor — DeepSeek", () => {
  test("deepseek-flash reports a 1M context window", () => {
    expect(contextWindowFor("deepseek", "deepseek-flash")).toBe(1_000_000);
  });

  test("deepseek-v4-pro also reports a 1M context window", () => {
    expect(contextWindowFor("deepseek", "deepseek-v4-pro")).toBe(1_000_000);
  });

  test("does not infer hosted context limits for local compatible endpoints", () => {
    // Local servers must report their actual context length.
    expect(contextWindowFor("openai-compatible", "deepseek-flash")).toBeUndefined();
  });
});
