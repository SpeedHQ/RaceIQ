import { describe, expect, test } from "bun:test";

import { contextWindowFor } from "./context-window";

describe("contextWindowFor — DeepSeek", () => {
  test("deepseek-flash 报告 1M 上下文", () => {
    expect(contextWindowFor("deepseek", "deepseek-flash")).toBe(1_000_000);
  });

  test("deepseek-v4-pro 同样 1M", () => {
    expect(contextWindowFor("deepseek", "deepseek-v4-pro")).toBe(1_000_000);
  });

  test("深求不与本地兼容端点的“未知”分支混淆", () => {
    // openai-compatible 没有真实上下文长度时必须返回 undefined，而不是 1M
    expect(contextWindowFor("openai-compatible", "deepseek-flash")).toBeUndefined();
  });
});
