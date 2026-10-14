import { describe, expect, test } from "bun:test";
import { chatRequestHasImage, resolveChatVisionCapability } from "@raceiq/shared/integrations/ai/chat-vision";

describe("chat image capability", () => {
  test("recognizes only verified provider-specific vision model IDs", () => {
    expect(resolveChatVisionCapability("gemini", "gemini-2.5-flash")).toBe("supported");
    expect(resolveChatVisionCapability("gemini", "gemini-2.0-flash-001")).toBe("supported");
    expect(resolveChatVisionCapability("openai", "gpt-4o-mini")).toBe("supported");
    expect(resolveChatVisionCapability("openai", "gpt-4o-2024-08-06")).toBe("supported");
    expect(resolveChatVisionCapability("openai", "gpt-4.1")).toBe("supported");
    expect(resolveChatVisionCapability("openai", "o3")).toBe("supported");
  });

  test("rejects known text-only and specialized audio models", () => {
    expect(resolveChatVisionCapability("openai", "o1-mini")).toBe("unsupported");
    expect(resolveChatVisionCapability("openai", "o1-preview")).toBe("unsupported");
    expect(resolveChatVisionCapability("openai", "o3-mini")).toBe("unsupported");
    expect(resolveChatVisionCapability("openai", "gpt-4o-mini-tts")).toBe("unsupported");
    expect(resolveChatVisionCapability("openai", "gpt-4o-audio-preview")).toBe("unsupported");
    expect(resolveChatVisionCapability("gemini", "gemini-embedding-001")).toBe("unsupported");
  });

  test("keeps providers and unverified model IDs unknown", () => {
    expect(resolveChatVisionCapability("openai-compatible", "gpt-4o")).toBe("unknown");
    expect(resolveChatVisionCapability("openai", "o5")).toBe("unknown");
    expect(resolveChatVisionCapability("openai", "future-vision-model")).toBe("unknown");
    expect(resolveChatVisionCapability("gemini", "gemini-4-pro")).toBe("unknown");
    expect(resolveChatVisionCapability("gemini", "gemini-flash-latest")).toBe("unknown");
  });

  test("detects image payloads across supported message formats and MIME casing", () => {
    expect(chatRequestHasImage([{ parts: [{ type: "file", mediaType: "IMAGE/PNG", url: "https://example.test/image" }] }])).toBe(true);
    expect(chatRequestHasImage([{ content: [{ type: "image", image: "https://example.test/image" }] }])).toBe(true);
    expect(chatRequestHasImage([{ parts: [{ type: "file", mimeType: "image/jpeg", data: "binary" }] }])).toBe(true);
    expect(chatRequestHasImage([{ parts: [{ type: "file", url: "data:image/png;base64,AA==" }] }])).toBe(true);
    expect(chatRequestHasImage([{ parts: [{ type: "text", text: "Explain this image" }, { type: "file", mediaType: "text/plain", url: "https://example.test/document" }] }])).toBe(false);
  });
});
