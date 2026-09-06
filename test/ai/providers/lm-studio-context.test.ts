import { describe, expect, test } from "bun:test";
import { extractLmStudioContextLengths, getLocalModelsDetailed } from "../../../server/ai/providers";

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
      const result = await getLocalModelsDetailed("http://local.test/v1", "gateway-secret");
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
      await getLocalModelsDetailed("http://local.test/v1");
      expect(requests.every((request) => !new Headers(request.headers).has("authorization"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
