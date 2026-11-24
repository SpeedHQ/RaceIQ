import { describe, expect, test } from "bun:test";

import {
  defaultModelFor,
  defaultReasoningEffortFor,
  describeCompatibleApiFailure,
  isDeepSeekEndpoint,
  isSupportedAiProvider,
  mapDeepSeekModels,
  responseFormatFor,
} from "../../ai/provider-capabilities";

describe("isDeepSeekEndpoint", () => {
  test("recognizes the official endpoint with or without trailing slashes", () => {
    expect(isDeepSeekEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isDeepSeekEndpoint("https://api.deepseek.com/")).toBe(true);
  });

  test("rejects other endpoints", () => {
    expect(isDeepSeekEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isDeepSeekEndpoint("http://localhost:1234/v1")).toBe(false);
    expect(isDeepSeekEndpoint(undefined)).toBe(false);
  });
});

describe("defaultReasoningEffortFor", () => {
  test("omits reasoning_effort for DeepSeek because the transport disables thinking", () => {
    expect(defaultReasoningEffortFor("https://api.deepseek.com")).toBeUndefined();
  });

  test("keeps reasoning disabled for local compatible endpoints", () => {
    expect(defaultReasoningEffortFor("http://localhost:1234/v1")).toBe("none");
  });

  test("omits reasoning_effort for official OpenAI and Anthropic endpoints", () => {
    expect(defaultReasoningEffortFor("https://api.openai.com/v1")).toBeUndefined();
    expect(defaultReasoningEffortFor("https://api.anthropic.com/v1")).toBeUndefined();
  });
});

describe("defaultModelFor", () => {
  test("provides a deterministic default model for each provider", () => {
    expect(defaultModelFor("gemini")).toBe("gemini-flash-latest");
    expect(defaultModelFor("openai")).toBe("gpt-4o-mini");
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-5-5");
    expect(defaultModelFor("deepseek")).toBe("deepseek-flash");
    expect(defaultModelFor("openai-compatible")).toBe("local-model");
  });

  test("uses the compatible-endpoint default for unknown providers", () => {
    expect(defaultModelFor("something-else")).toBe("local-model");
  });
});

describe("isSupportedAiProvider", () => {
  test("accepts DeepSeek at runtime", () => {
    expect(isSupportedAiProvider("deepseek")).toBe(true);
  });

  test("preserves existing providers", () => {
    for (const id of ["gemini", "openai", "anthropic", "openai-compatible"]) {
      expect(isSupportedAiProvider(id)).toBe(true);
    }
  });

  test("rejects unknown providers instead of silently selecting another branch", () => {
    expect(isSupportedAiProvider("local")).toBe(false);
    expect(isSupportedAiProvider("")).toBe(false);
    expect(isSupportedAiProvider("deepseek ")).toBe(false);
  });
});

describe("mapDeepSeekModels", () => {
  test("maps a models response to displayable entries", () => {
    const mapped = mapDeepSeekModels({
      object: "list",
      data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
    });

    expect(mapped).toEqual([
      { id: "deepseek-flash", name: "deepseek-flash" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    ]);
  });

  test("ignores malformed entries", () => {
    const mapped = mapDeepSeekModels({ data: [{ id: "ok" }, { id: 42 }, null, {}] });
    expect(mapped).toEqual([{ id: "ok", name: "ok" }]);
  });

  test("returns an empty list for invalid responses", () => {
    expect(mapDeepSeekModels(null)).toEqual([]);
    expect(mapDeepSeekModels("nope")).toEqual([]);
    expect(mapDeepSeekModels({})).toEqual([]);
  });
});

describe("responseFormatFor", () => {
  test("uses json_object for DeepSeek", () => {
    expect(responseFormatFor("https://api.deepseek.com")).toBe("json_object");
  });

  test("preserves native json_schema for other endpoints", () => {
    expect(responseFormatFor("https://api.openai.com/v1")).toBe("json_schema");
    expect(responseFormatFor("http://localhost:1234/v1")).toBe("json_schema");
    expect(responseFormatFor(undefined)).toBe("json_schema");
  });
});

describe("describeCompatibleApiFailure", () => {
  test("names DeepSeek instead of reporting an OpenAI failure", () => {
    expect(describeCompatibleApiFailure("deepseek", 500)).toBe("DeepSeek API error: 500");
    expect(describeCompatibleApiFailure("deepseek", 500)).not.toContain("OpenAI");
  });

  test("explains DeepSeek's insufficient balance", () => {
    expect(describeCompatibleApiFailure("deepseek", 402)).toContain("insufficient account balance");
    expect(describeCompatibleApiFailure("deepseek", 402)).toContain("platform.deepseek.com");
  });

  test("keeps the key hint for 401 on every provider", () => {
    expect(describeCompatibleApiFailure("deepseek", 401)).toBe("Invalid API key. Check your key in Settings.");
    expect(describeCompatibleApiFailure("openai", 401)).toBe("Invalid API key. Check your key in Settings.");
  });

  test("keeps provider-specific labels for the other endpoints", () => {
    expect(describeCompatibleApiFailure("openai", 500)).toBe("OpenAI API error: 500");
    expect(describeCompatibleApiFailure("anthropic", 500)).toBe("Anthropic API error: 500");
    expect(describeCompatibleApiFailure("openai-compatible", 500)).toBe("OpenAI-compatible API error: 500");
  });
});
