import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { getAnthropicModelsDetailed, getProviders } from "@raceiq/backend-core/ai/providers";
import { AnthropicProviderAdapter } from "../../../src/ai/provider-adapters";

type CapturedRequest = { url: string; init: RequestInit };

function installFetchStub(requests: CapturedRequest[], body: unknown) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

const completion = {
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

describe("Claude (Anthropic) provider", () => {
  test("is offered as a provider", () => {
    expect(getProviders()).toContainEqual({ id: "anthropic", name: "Claude (Anthropic)" });
  });

  test("lists Claude models with display names in Anthropic's order", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, {
      data: [
        { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", type: "model", created_at: "2026-09-01T00:00:00Z" },
        { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", type: "model", created_at: "2026-08-01T00:00:00Z" },
      ],
      has_more: false,
      first_id: "claude-sonnet-5-5",
      last_id: "claude-haiku-5-5",
    });
    try {
      const result = await getAnthropicModelsDetailed("test-key");
      expect(result).toEqual({
        models: [
          { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
          { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
        ],
        error: null,
      });
      expect(requests[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
      const headers = new Headers(requests[0].init.headers);
      expect(headers.get("x-api-key")).toBe("test-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
    } finally {
      restore();
    }
  });

  test("reports the upstream error when the model list fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("bad key", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    try {
      const result = await getAnthropicModelsDetailed("test-key");
      expect(result.models).toEqual([]);
      expect(result.error).toContain("Anthropic models request failed (401 Unauthorized)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends direct and Mastra requests to Anthropic with Anthropic auth and no reasoning_effort", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      const adapter = new AnthropicProviderAdapter({ feature: "chat", model: "claude-haiku-5-5", apiKey: "test-key" });
      await adapter.generateText({ prompt: "ping" });
      await generateText({ model: adapter.mastraModel as unknown as LanguageModel, prompt: "ping" });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe("https://api.anthropic.com/v1/chat/completions");
        const headers = new Headers(request.init.headers);
        expect(headers.get("authorization")).toBe("Bearer test-key");
        expect(headers.get("x-api-key")).toBe("test-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        const body = JSON.parse(String(request.init.body));
        expect(body.model).toBe("claude-haiku-5-5");
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(body).not.toHaveProperty("temperature");
      }
    } finally {
      restore();
    }
  });
});
