import { describe, expect, test } from "bun:test";

import { isAiAnalysisConfigured, isAiConfigured, launchAiFeature } from "../client/src/lib/is-ai-configured";

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

describe("isAiAnalysisConfigured", () => {
  test("requires a selected analysis model after provider credentials are configured", () => {
    expect(isAiAnalysisConfigured({ aiProvider: "gemini", geminiApiKeySet: true, aiModel: "" })).toBe(false);
    expect(isAiAnalysisConfigured({ aiProvider: "openai", openaiApiKeySet: true, aiModel: "   " })).toBe(false);
    expect(isAiAnalysisConfigured({ aiProvider: "local", aiModel: "" })).toBe(false);
    expect(isAiAnalysisConfigured({ aiProvider: "", geminiApiKeySet: true, aiModel: "gemini-2.5-flash" })).toBe(false);
  });

  test("accepts a selected model with valid provider credentials", () => {
    expect(isAiAnalysisConfigured({ aiProvider: "gemini", geminiApiKeySet: true, aiModel: "gemini-2.5-flash" })).toBe(true);
    expect(isAiAnalysisConfigured({ aiProvider: "openai", openaiApiKeySet: true, aiModel: "gpt-5" })).toBe(true);
    expect(isAiAnalysisConfigured({ aiProvider: "local", aiModel: "qwen3" })).toBe(true);
  });
});

describe("launchAiFeature", () => {
  test("opens the AI feature when AI is configured", () => {
    const calls: string[] = [];

    launchAiFeature(true, () => calls.push("feature"), () => calls.push("configure"));

    expect(calls).toEqual(["feature"]);
  });

  test("opens AI configuration instead of the feature when AI is not configured", () => {
    const calls: string[] = [];

    launchAiFeature(false, () => calls.push("feature"), () => calls.push("configure"));

    expect(calls).toEqual(["configure"]);
  });
});
