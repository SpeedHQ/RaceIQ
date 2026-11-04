import { describe, expect, test } from "bun:test";

import { baseUrlFor } from "./provider-endpoints";

describe("baseUrlFor — 每个 provider 的固定端点", () => {
  test("deepseek 用官方 OpenAI 兼容端点", () => {
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
