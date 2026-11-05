import { describe, expect, test } from "bun:test";

import { resolveChatVisionCapability } from "./chat-vision";

describe("resolveChatVisionCapability — DeepSeek", () => {
  test("deepseek-flash supports image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-flash")).toBe("supported");
  });

  test("deepseek-v4-pro does not support image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-v4-pro")).toBe("unsupported");
  });

  test("normalizes model name case and surrounding whitespace", () => {
    expect(resolveChatVisionCapability("deepseek", "  DeepSeek-Flash  ")).toBe("supported");
  });

  test("leaves unknown providers outside the DeepSeek branch", () => {
    expect(resolveChatVisionCapability("openai-compatible", "some-local-model")).toBe("unknown");
  });
});
