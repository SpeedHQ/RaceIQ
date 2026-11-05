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
  test("识别官方端点，忽略结尾斜杠", () => {
    expect(isDeepSeekEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isDeepSeekEndpoint("https://api.deepseek.com/")).toBe(true);
  });

  test("其他端点不算", () => {
    expect(isDeepSeekEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isDeepSeekEndpoint("http://localhost:1234/v1")).toBe(false);
    expect(isDeepSeekEndpoint(undefined)).toBe(false);
  });
});

describe("defaultReasoningEffortFor", () => {
  test("DeepSeek 默认为 medium（官方支持 low/medium/high）", () => {
    expect(defaultReasoningEffortFor("https://api.deepseek.com")).toBe("medium");
  });

  test("本地兼容端点保持关闭推理", () => {
    expect(defaultReasoningEffortFor("http://localhost:1234/v1")).toBe("none");
  });

  test("OpenAI 与 Anthropic 官方端点不设置该字段", () => {
    expect(defaultReasoningEffortFor("https://api.openai.com/v1")).toBeUndefined();
    expect(defaultReasoningEffortFor("https://api.anthropic.com/v1")).toBeUndefined();
  });
});

describe("defaultModelFor", () => {
  test("每个 provider 都有确定的默认模型", () => {
    expect(defaultModelFor("gemini")).toBe("gemini-flash-latest");
    expect(defaultModelFor("openai")).toBe("gpt-4o-mini");
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-5-5");
    expect(defaultModelFor("deepseek")).toBe("deepseek-flash");
    expect(defaultModelFor("openai-compatible")).toBe("local-model");
  });

  test("未知 provider 回落到兼容端点默认值", () => {
    expect(defaultModelFor("something-else")).toBe("local-model");
  });
});

describe("isSupportedAiProvider", () => {
  test("DeepSeek 被运行时接受", () => {
    expect(isSupportedAiProvider("deepseek")).toBe(true);
  });

  test("既有 provider 一个不少", () => {
    for (const id of ["gemini", "openai", "anthropic", "openai-compatible"]) {
      expect(isSupportedAiProvider(id)).toBe(true);
    }
  });

  test("未知 provider 被拒绝（不再静默走错分支）", () => {
    expect(isSupportedAiProvider("local")).toBe(false);
    expect(isSupportedAiProvider("")).toBe(false);
    expect(isSupportedAiProvider("deepseek ")).toBe(false);
  });
});

describe("mapDeepSeekModels", () => {
  test("把 /models 响应映射成可展示的模型列表", () => {
    const mapped = mapDeepSeekModels({
      object: "list",
      data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
    });

    expect(mapped).toEqual([
      { id: "deepseek-flash", name: "deepseek-flash" },
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
    ]);
  });

  test("忽略形状不合法的条目", () => {
    const mapped = mapDeepSeekModels({ data: [{ id: "ok" }, { id: 42 }, null, {}] });
    expect(mapped).toEqual([{ id: "ok", name: "ok" }]);
  });

  test("响应不是对象时返回空数组", () => {
    expect(mapDeepSeekModels(null)).toEqual([]);
    expect(mapDeepSeekModels("nope")).toEqual([]);
    expect(mapDeepSeekModels({})).toEqual([]);
  });
});

describe("responseFormatFor", () => {
  test("DeepSeek 只接受 json_object", () => {
    expect(responseFormatFor("https://api.deepseek.com")).toBe("json_object");
  });

  test("其他端点保持原生 json_schema", () => {
    expect(responseFormatFor("https://api.openai.com/v1")).toBe("json_schema");
    expect(responseFormatFor("http://localhost:1234/v1")).toBe("json_schema");
    expect(responseFormatFor(undefined)).toBe("json_schema");
  });
});