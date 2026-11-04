import { describe, expect, test } from "bun:test";

import { resolveChatVisionCapability } from "./chat-vision";

describe("resolveChatVisionCapability — DeepSeek", () => {
  test("deepseek-flash 支持图片输入", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-flash")).toBe("supported");
  });

  test("deepseek-v4-pro 不支持图片输入", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-v4-pro")).toBe("unsupported");
  });

  test("模型名大小写与前后空格不影响判定", () => {
    expect(resolveChatVisionCapability("deepseek", "  DeepSeek-Flash  ")).toBe("supported");
  });

  test("未知 provider 仍返回 unknown，不被 DeepSeek 分支吞掉", () => {
    expect(resolveChatVisionCapability("openai-compatible", "some-local-model")).toBe("unknown");
  });
});
