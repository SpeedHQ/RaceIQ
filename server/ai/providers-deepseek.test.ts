import { describe, expect, test } from "bun:test";

import { getProviders } from "./providers";

describe("provider registry — DeepSeek", () => {
  test("includes DeepSeek", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toContain("deepseek");
  });

  test("uses DeepSeek as the display name", () => {
    const deepseek = getProviders().find((p) => p.id === "deepseek");
    expect(deepseek?.name).toBe("DeepSeek");
  });

  test("preserves existing providers", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gemini", "openai", "anthropic", "openai-compatible"]),
    );
  });
});
