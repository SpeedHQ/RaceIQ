import { describe, expect, test } from "bun:test";

import { resolveChatVisionCapability } from "./chat-vision";

describe("resolveChatVisionCapability — DeepSeek", () => {
  test("deepseek-flash accepts image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-flash")).toBe("supported");
  });

  test("deepseek-v4-pro does not accept image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-v4-pro")).toBe("unsupported");
  });

  test("model-name casing and surrounding spaces do not change the verdict", () => {
    expect(resolveChatVisionCapability("deepseek", "  DeepSeek-Flash  ")).toBe("supported");
  });

  test("unknown providers still return unknown instead of being swallowed by the DeepSeek branch", () => {
    expect(resolveChatVisionCapability("openai-compatible", "some-local-model")).toBe("unknown");
  });
});
