import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { getProviders } from "@raceiq/backend-core/ai/providers";
import { DEEPSEEK_AGENT_DEFAULTS } from "../../../src/mastra/model";
import { DeepSeekProviderAdapter } from "../../../src/ai/provider-adapters";

process.env.DEEPSEEK_API_KEY = "test-key";

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

  test("direct requests go to the DeepSeek endpoint with thinking off", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      await adapter().generateText({ prompt: "ping" });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
      expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer test-key");
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.model).toBe("deepseek-flash");
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body).not.toHaveProperty("reasoning_effort");
    } finally {
      restore();
    }
  });

  test("Mastra binds the native DeepSeek provider and switches thinking off", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      const agent = new Agent({
        id: "deepseek-provider-test",
        name: "DeepSeek provider test",
        instructions: "ping",
        model: () => "deepseek/deepseek-flash",
        defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
      });
      // The stub answers with JSON while the SDK streams; the request shape is
      // what this test pins, so a response-parsing error after it is irrelevant.
      await agent.generate("ping").catch(() => undefined);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.model).toBe("deepseek-flash");
      expect(body.thinking).toEqual({ type: "disabled" });
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
});
