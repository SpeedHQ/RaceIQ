import { describe, expect, test } from "bun:test";

import { contextWindowFor } from "./context-window";

describe("contextWindowFor — DeepSeek", () => {
  test("deepseek-flash reports a 1M context window", () => {
    expect(contextWindowFor("deepseek", "deepseek-flash")).toBe(1_000_000);
  });

  test("deepseek-v4-pro also reports 1M", () => {
    expect(contextWindowFor("deepseek", "deepseek-v4-pro")).toBe(1_000_000);
  });

  test("DeepSeek is not confused with the local endpoint's unknown branch", () => {
    // openai-compatible must return undefined, not 1M, when the real context length is unknown
    expect(contextWindowFor("openai-compatible", "deepseek-flash")).toBeUndefined();
  });
});
