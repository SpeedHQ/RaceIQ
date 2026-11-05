import { describe, expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import { getProviders } from "@raceiq/backend-core/ai/providers";
import { deepseekCompatibleFetch } from "@raceiq/backend-core/ai/openai-compatible-headers";
import { DeepSeekProviderAdapter } from "../../../src/ai/provider-adapters";

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
  choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

const adapter = () =>
  new DeepSeekProviderAdapter({ feature: "chat", model: "deepseek-flash", apiKey: "test-key" });

describe("DeepSeek provider", () => {
  test("is offered as a provider", () => {
    expect(getProviders()).toContainEqual({ id: "deepseek", name: "DeepSeek" });
  });

  test("sends direct and Mastra requests to DeepSeek with thinking switched off", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      const deepseek = adapter();
      await deepseek.generateText({ prompt: "ping" });
      await generateText({ model: deepseek.mastraModel as unknown as LanguageModel, prompt: "ping" });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe("https://api.deepseek.com/chat/completions");
        expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer test-key");
        const body = JSON.parse(String(request.init.body));
        expect(body.model).toBe("deepseek-flash");
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body).not.toHaveProperty("reasoning_effort");
      }
    } finally {
      restore();
    }
  });

  test("structured requests ask for json_object and carry the schema in the prompt", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      await adapter().generateStructured({ prompt: "ping", schema: { type: "object", properties: { verdict: { type: "string" } } } });
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(body)).not.toContain("json_schema");
      expect(body.messages[0].content).toContain('"verdict"');
    } finally {
      restore();
    }
  });

  test("downgrades the native json_schema pass Mastra emits for its structuring step", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const shim = deepseekCompatibleFetch(globalThis.fetch);
      await shim("https://api.deepseek.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-flash",
          messages: [{ role: "user", content: "structure this" }],
          response_format: { type: "json_schema", json_schema: { name: "out", strict: true, schema: { type: "object" } } },
          reasoning_effort: "medium",
        }),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].response_format).toEqual({ type: "json_object" });
      expect(seen[0].thinking).toEqual({ type: "disabled" });
      expect(seen[0]).not.toHaveProperty("reasoning_effort");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
