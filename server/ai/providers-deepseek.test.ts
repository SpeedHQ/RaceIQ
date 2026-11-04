import { describe, expect, test } from "bun:test";

import { getProviders } from "./providers";

describe("provider 注册表 — DeepSeek 是一等公民", () => {
  test("列表里包含 deepseek", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toContain("deepseek");
  });

  test("显示名是 DeepSeek", () => {
    const deepseek = getProviders().find((p) => p.id === "deepseek");
    expect(deepseek?.name).toBe("DeepSeek");
  });

  test("原有 provider 未被移除", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["gemini", "openai", "anthropic", "openai-compatible"]),
    );
  });
});
