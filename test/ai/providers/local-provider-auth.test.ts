import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { OpenAiCompatibleProviderAdapter } from "../../../server/ai/provider-adapters";

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
});
