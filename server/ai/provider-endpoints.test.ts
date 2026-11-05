import { describe, expect, test } from "bun:test";

import { baseUrlFor } from "./provider-endpoints";

describe("baseUrlFor — fixed endpoint per provider", () => {
  test("deepseek uses its official OpenAI-compatible endpoint", () => {
    expect(baseUrlFor("deepseek")).toBe("https://api.deepseek.com");
  });

  test("openai 用官方端点", () => {
    expect(baseUrlFor("openai")).toBe("https://api.openai.com/v1");
  });

  test("openai-compatible 没有固定端点（由用户填写）", () => {
    expect(baseUrlFor("openai-compatible")).toBeUndefined();
  });

  test("gemini 不走 OpenAI 兼容层", () => {
    expect(baseUrlFor("gemini")).toBeUndefined();
  });
});
