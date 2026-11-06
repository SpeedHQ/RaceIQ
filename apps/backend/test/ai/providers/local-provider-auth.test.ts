import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { getOpenAiCompatibleModelsDetailed } from "@raceiq/backend-core/ai/providers";
import { OpenAiCompatibleProviderAdapter } from "../../../src/ai/provider-adapters";

const endpoint = "http://local.test/v1";

function installFetchStub(requests: RequestInit[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

describe("Local provider authentication", () => {
  test("forwards configured key through direct and Mastra generation", async () => {
    const requests: RequestInit[] = [];
    const restore = installFetchStub(requests);
    try {
      const adapter = new OpenAiCompatibleProviderAdapter({ feature: "analysis", model: "qwen", endpoint, apiKey: "gateway-secret" });
      await adapter.generateText({ prompt: "ping" });
      await generateText({ model: adapter.mastraModel as unknown as LanguageModel, prompt: "ping" });
      expect(requests).toHaveLength(2);
      expect(new Headers(requests[0].headers).get("authorization")).toBe("Bearer gateway-secret");
      expect(new Headers(requests[1].headers).get("authorization")).toBe("Bearer gateway-secret");
    } finally {
      restore();
    }
  });

  test("keeps anonymous direct calls and SDK fallback key", async () => {
    const requests: RequestInit[] = [];
    const restore = installFetchStub(requests);
    try {
      const adapter = new OpenAiCompatibleProviderAdapter({ feature: "analysis", model: "qwen", endpoint });
      await adapter.generateText({ prompt: "ping" });
      await generateText({ model: adapter.mastraModel as unknown as LanguageModel, prompt: "ping" });
      expect(requests).toHaveLength(2);
      expect(new Headers(requests[0].headers).has("authorization")).toBe(false);
      expect(new Headers(requests[1].headers).get("authorization")).toBe("Bearer local");
    } finally {
      restore();
    }
  });

  test("adds x-api-key and anthropic-version only for Anthropic's endpoint", async () => {
    const requests: RequestInit[] = [];
    const restore = installFetchStub(requests);
    try {
      const anthropic = new OpenAiCompatibleProviderAdapter({ feature: "analysis", model: "claude-haiku-5-5", endpoint: "https://api.anthropic.com/v1/", apiKey: "test-key" });
      await anthropic.generateText({ prompt: "ping" });
      await generateText({ model: anthropic.mastraModel as unknown as LanguageModel, prompt: "ping" });
      const local = new OpenAiCompatibleProviderAdapter({ feature: "analysis", model: "qwen", endpoint, apiKey: "test-key" });
      await local.generateText({ prompt: "ping" });
      await generateText({ model: local.mastraModel as unknown as LanguageModel, prompt: "ping" });
      expect(requests).toHaveLength(4);
      for (const request of requests.slice(0, 2)) {
        const headers = new Headers(request.headers);
        expect(headers.get("authorization")).toBe("Bearer test-key");
        expect(headers.get("x-api-key")).toBe("test-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
      }
      for (const request of requests.slice(2)) {
        const headers = new Headers(request.headers);
        expect(headers.get("authorization")).toBe("Bearer test-key");
        expect(headers.has("x-api-key")).toBe(false);
        expect(headers.has("anthropic-version")).toBe(false);
      }
    } finally {
      restore();
    }
  });

  test("lists Anthropic models with Anthropic auth headers in one page", async () => {
    const urls: string[] = [];
    const requests: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      requests.push(init ?? {});
      return new Response(JSON.stringify({
        data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", type: "model", created_at: "2026-01-01T00:00:00Z" }],
        has_more: false,
        first_id: "claude-haiku-5-5",
        last_id: "claude-haiku-5-5",
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await getOpenAiCompatibleModelsDetailed("https://api.anthropic.com/v1", "test-key");
      expect(result.error).toBeNull();
      expect(result.models.map((model) => model.id)).toEqual(["claude-haiku-5-5"]);
      expect(urls).toEqual(["https://api.anthropic.com/v1/models?limit=1000"]);
      const headers = new Headers(requests[0].headers);
      expect(headers.get("x-api-key")).toBe("test-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
