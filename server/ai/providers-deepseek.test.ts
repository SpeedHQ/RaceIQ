import { describe, expect, test } from "bun:test";

import { getProviders } from "./providers";

describe("provider registry — DeepSeek is a first-class provider", () => {
  test("the list includes deepseek", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toContain("deepseek");
  });

  test("the display name is DeepSeek", () => {
    const deepseek = getProviders().find((p) => p.id === "deepseek");
    expect(deepseek?.name).toBe("DeepSeek");
  });

  test("no existing provider was removed", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gemini", "openai", "anthropic", "openai-compatible"]),
    );
  });
});
