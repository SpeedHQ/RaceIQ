import { describe, expect, test } from "bun:test";

import { isAiConfigured } from "../client/src/lib/is-ai-configured";

describe("isAiConfigured", () => {
  test("treats local provider as configured without API keys", () => {
    expect(isAiConfigured({ aiProvider: "local", geminiApiKeySet: false, openaiApiKeySet: false })).toBe(true);
  });

  test("requires OpenAI key when provider is openai", () => {
    expect(isAiConfigured({ aiProvider: "openai", openaiApiKeySet: true })).toBe(true);
    expect(isAiConfigured({ aiProvider: "openai", openaiApiKeySet: false })).toBe(false);
  });

  test("requires Gemini key for gemini and default provider", () => {
    expect(isAiConfigured({ aiProvider: "gemini", geminiApiKeySet: true })).toBe(true);
    expect(isAiConfigured({ aiProvider: "gemini", geminiApiKeySet: false })).toBe(false);
    expect(isAiConfigured({ geminiApiKeySet: true })).toBe(true);
    expect(isAiConfigured({})).toBe(false);
  });
});
