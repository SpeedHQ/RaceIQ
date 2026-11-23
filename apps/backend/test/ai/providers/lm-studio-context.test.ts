import { describe, expect, test } from "bun:test";
import { extractLmStudioContextLengths, getOpenAiCompatibleModelsDetailed, getOpenAiModelsDetailed } from "@raceiq/backend-core/ai/providers";

describe("LM Studio context discovery", () => {
  test("uses loaded runtime context instead of model maximum", () => {
    const contexts = extractLmStudioContextLengths({
      models: [
        {
          key: "qwen/qwen3.5-9b",
          max_context_length: 262144,
          loaded_instances: [{ id: "qwen/qwen3.5-9b", config: { context_length: 8192 } }],
        },
      ],
    });

    expect(contexts.get("qwen/qwen3.5-9b")).toBe(8192);
  });

  test("authenticates model and context discovery when key is configured", async () => {
    const originalFetch = globalThis.fetch;
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      const url = String(input);
      if (url.includes("/api/")) {
        return new Response(JSON.stringify({
          models: [{ key: "qwen", loaded_instances: [{ id: "qwen", config: { context_length: 8192 } }] }],
        }));
      }
      return new Response(JSON.stringify({ data: [{ id: "qwen" }] }));
    }) as typeof fetch;
    try {
      const result = await getOpenAiCompatibleModelsDetailed("http://local.test/v1", "gateway-secret");
      expect(result.models[0]?.contextLength).toBe(8192);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => new Headers(request.headers).get("authorization") === "Bearer gateway-secret")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("omits authentication for anonymous discovery", async () => {
    const originalFetch = globalThis.fetch;
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ data: [{ id: "qwen" }] }));
    }) as typeof fetch;
    try {
      await getOpenAiCompatibleModelsDetailed("http://local.test/v1");
      expect(requests.every((request) => !new Headers(request.headers).has("authorization"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAI model discovery", () => {
  test("uses the configured key and lists only GPT-6 and newer text models", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorization = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        data: [
          { id: "gpt-7" },
          { id: "gpt-6.1-mini-2026-11-01" },
          { id: "gpt-6" },
          { id: "gpt-5.9" },
          { id: "gpt-6o" },
          { id: "o4-mini" },
          { id: "gpt-6-audio-preview" },
          { id: "gpt-6-realtime" },
          { id: "gpt-6-mini-transcribe" },
          { id: "gpt-6-tts" },
          { id: "gpt-6-codex" },
          { id: "gpt-6-search-preview" },
          { id: "gpt-image-1" },
          { id: "text-embedding-3-large" },
          { id: 42 },
        ],
      });
    }) as typeof fetch;
    try {
      const result = await getOpenAiModelsDetailed("openai-secret");
      expect(requestedUrl).toBe("https://api.openai.com/v1/models");
      expect(authorization).toBe("Bearer openai-secret");
      expect(result.models).toEqual([
        { id: "gpt-6", name: "gpt-6" },
        { id: "gpt-6.1-mini-2026-11-01", name: "gpt-6.1-mini-2026-11-01" },
        { id: "gpt-7", name: "gpt-7" },
      ]);
      expect(result.error).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
