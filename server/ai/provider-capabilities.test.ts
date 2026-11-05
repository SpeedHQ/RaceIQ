import { describe, expect, test } from "bun:test";

import {
  defaultModelFor,
  defaultReasoningEffortFor,
  isDeepSeekEndpoint,
  isSupportedAiProvider,
  mapDeepSeekModels,
  responseFormatFor,
} from "./provider-capabilities";

describe("isDeepSeekEndpoint", () => {
  test("recognises the official endpoint and ignores a trailing slash", () => {
    expect(isDeepSeekEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isDeepSeekEndpoint("https://api.deepseek.com/")).toBe(true);
  });

  test("other endpoints are not DeepSeek", () => {
    expect(isDeepSeekEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isDeepSeekEndpoint("http://localhost:1234/v1")).toBe(false);
    expect(isDeepSeekEndpoint(undefined)).toBe(false);
  });
});

describe("defaultReasoningEffortFor", () => {
  test("DeepSeek sends no reasoning_effort (thinking is disabled in transport)", () => {
    expect(defaultReasoningEffortFor("https://api.deepseek.com")).toBeUndefined();
  });

  test("local compatible endpoints keep reasoning off", () => {
    expect(defaultReasoningEffortFor("http://localhost:1234/v1")).toBe("none");
  });

  test("OpenAI and Anthropic endpoints leave the field unset", () => {
    expect(defaultReasoningEffortFor("https://api.openai.com/v1")).toBeUndefined();
    expect(defaultReasoningEffortFor("https://api.anthropic.com/v1")).toBeUndefined();
  });
});

describe("defaultModelFor", () => {
  test("every provider has a deterministic default model", () => {
    expect(defaultModelFor("gemini")).toBe("gemini-flash-latest");
    expect(defaultModelFor("openai")).toBe("gpt-4o-mini");
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-5-5");
    expect(defaultModelFor("deepseek")).toBe("deepseek-flash");
    expect(defaultModelFor("openai-compatible")).toBe("local-model");
  });

  test("unknown providers fall back to the compatible default", () => {
    expect(defaultModelFor("something-else")).toBe("local-model");
  });
});

describe("isSupportedAiProvider", () => {
  test("the runtime accepts DeepSeek", () => {
    expect(isSupportedAiProvider("deepseek")).toBe(true);
  });

  test("no existing provider is missing", () => {
    for (const id of ["gemini", "openai", "anthropic", "openai-compatible"]) {
      expect(isSupportedAiProvider(id)).toBe(true);
    }
  });

  test("unknown providers are rejected instead of silently taking a wrong branch", () => {
    expect(isSupportedAiProvider("local")).toBe(false);
    expect(isSupportedAiProvider("")).toBe(false);
    expect(isSupportedAiProvider("deepseek ")).toBe(false);
  });
});

describe("mapDeepSeekModels", () => {
  test("maps a /models response to a displayable model list", () => {
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

  test("returns an empty list when the response is not an object", () => {
    expect(mapDeepSeekModels(null)).toEqual([]);
    expect(mapDeepSeekModels("nope")).toEqual([]);
    expect(mapDeepSeekModels({})).toEqual([]);
  });
});

describe("responseFormatFor", () => {
  test("DeepSeek only accepts json_object", () => {
    expect(responseFormatFor("https://api.deepseek.com")).toBe("json_object");
  });

  test("other endpoints keep native json_schema", () => {
    expect(responseFormatFor("https://api.openai.com/v1")).toBe("json_schema");
    expect(responseFormatFor("http://localhost:1234/v1")).toBe("json_schema");
    expect(responseFormatFor(undefined)).toBe("json_schema");
  });
});
