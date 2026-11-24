import { describe, expect, test } from "bun:test";

import { gateChatImages, resolveChatVisionCapability } from "../../../integrations/ai/chat-vision";

describe("resolveChatVisionCapability — DeepSeek", () => {
  test("deepseek-flash supports image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-flash")).toBe("supported");
  });

  test("dated deepseek-flash variant supports image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-flash-2026-01-01")).toBe("supported");
  });

  test("deepseek-v4-pro does not support image input", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-v4-pro")).toBe("unsupported");
  });

  test("unlisted deepseek model is unknown, not unsupported", () => {
    expect(resolveChatVisionCapability("deepseek", "deepseek-reasoner")).toBe("unknown");
  });

  test("normalizes model name case and surrounding whitespace", () => {
    expect(resolveChatVisionCapability("deepseek", "  DeepSeek-Flash  ")).toBe("supported");
  });

  test("leaves unknown providers outside the DeepSeek branch", () => {
    expect(resolveChatVisionCapability("openai-compatible", "some-local-model")).toBe("unknown");
  });
});

const imageTurn = {
  id: "image-turn",
  role: "user",
  parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" }],
};
const textTurn = { id: "text-turn", role: "user", parts: [{ type: "text", text: "Explain my braking" }] };

describe("gateChatImages", () => {
  test("text-only turns are allowed", () => {
    expect(gateChatImages("deepseek", "deepseek-v4-pro", [textTurn])).toEqual({ allowed: true });
  });

  test("an image turn with no stored model is blocked as unknown, never defaulted", () => {
    expect(gateChatImages("deepseek", "", [imageTurn])).toEqual({ allowed: false, capability: "unknown" });
  });

  test("an image turn with a text-only model is blocked as unsupported", () => {
    expect(gateChatImages("deepseek", "deepseek-v4-pro", [imageTurn])).toEqual({ allowed: false, capability: "unsupported" });
  });

  test("an image turn with a verified vision model is allowed", () => {
    expect(gateChatImages("deepseek", "deepseek-flash", [imageTurn])).toEqual({ allowed: true });
  });

  test("an image turn with an unverified model is blocked as unknown", () => {
    expect(gateChatImages("deepseek", "deepseek-reasoner", [imageTurn])).toEqual({ allowed: false, capability: "unknown" });
  });

  test("an image turn with no provider or model is blocked as unknown", () => {
    expect(gateChatImages(undefined, undefined, [imageTurn])).toEqual({ allowed: false, capability: "unknown" });
    expect(gateChatImages("", "", [imageTurn])).toEqual({ allowed: false, capability: "unknown" });
  });
});
