import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { getProviders } from "@raceiq/backend-core/ai/providers";
import { DEEPSEEK_AGENT_DEFAULTS } from "../../../src/mastra/model";
import { DeepSeekProviderAdapter, resolvedAiFromAdapter } from "../../../src/ai/provider-adapters";
import { createModelContext, getModel } from "../../../src/ai/model-provider";
import {
  buildEvalCompareEngineerAgent,
  buildEvalLapAnalystAgent,
} from "../../../src/mastra/evals/eval-agents";

const environment = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  EVALS_PROVIDER: process.env.EVALS_PROVIDER,
  EVALS_MODEL: process.env.EVALS_MODEL,
};
afterEach(() => {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

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
  id: "deepseek-test",
  object: "chat.completion",
  created: 1,
  model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
      const result = await adapter().generateText({ prompt: "ping" });
      expect(result.analysis).toBe('{"ok":true}');
      expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
      expect(new Headers(requests[0].init.headers).get("authorization")).toBe("Bearer test-key");
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body).not.toHaveProperty("reasoning_effort");
    } finally {
      restore();
    }
  });

  test("native structured generation preserves request credentials after the environment changes", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      process.env.DEEPSEEK_API_KEY = "old-global-key";
      const contexts = ["first-request-key", "second-request-key"].map((apiKey) =>
        createModelContext(resolvedAiFromAdapter(new DeepSeekProviderAdapter({
          feature: "chat", model: "deepseek-flash", apiKey,
        }))),
      );
      process.env.DEEPSEEK_API_KEY = "changed-global-key";
      const agent = new Agent({
        id: "deepseek-provider-test",
        name: "DeepSeek provider test",
        instructions: "Return JSON with ok set to true.",
        model: ({ requestContext }) => getModel("chat", requestContext),
        defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
      });
      for (const requestContext of contexts) {
        const result = await agent.generate("ping", {
          requestContext,
          structuredOutput: { schema: z.object({ ok: z.boolean() }) },
        });
        expect(result.object).toEqual({ ok: true });
      }
      expect(requests.map((request) => new Headers(request.init.headers).get("authorization")))
        .toEqual(["Bearer first-request-key", "Bearer second-request-key"]);
      for (const request of requests) {
        expect(request.url).toBe("https://api.deepseek.com/chat/completions");
        const body = JSON.parse(String(request.init.body));
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body.response_format).toEqual({ type: "json_object" });
      }
    } finally {
      restore();
    }
  });

  test("surfaces DeepSeek's own failures instead of OpenAI's", async () => {
    const originalFetch = globalThis.fetch;
    const respond = (status: number, payload: unknown) => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    };
    try {
      respond(402, { error: { message: "Insufficient Balance", type: "unknown_error" } });
      const balance = await adapter().generateText({ prompt: "ping" }).catch((error) => error);
      expect(balance.message).toContain("insufficient account balance");
      expect(balance.provider).toBe("deepseek");
      expect(balance.statusCode).toBe(402);

      respond(429, { error: { message: "Rate limit reached", type: "rate_limit_exceeded" } });
      const rateLimited = await adapter().generateText({ prompt: "ping" }).catch((error) => error);
      expect(rateLimited.message).toBe("DeepSeek API error: 429");
      expect(rateLimited.isRetryable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
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

describe("eval model selection", () => {
  test.each([undefined, "", "   "])("rejects an unspecified model (%s)", (model) => {
    process.env.EVALS_PROVIDER = "deepseek";
    if (model === undefined) delete process.env.EVALS_MODEL;
    else process.env.EVALS_MODEL = model;
    expect(() => buildEvalLapAnalystAgent()).toThrow("EVALS_MODEL");
    expect(() => buildEvalCompareEngineerAgent()).toThrow("EVALS_MODEL");
  });

  test.each([
    ["analyst", buildEvalLapAnalystAgent],
    ["comparison", buildEvalCompareEngineerAgent],
  ] as const)("%s eval generation disables DeepSeek thinking", async (_name, build) => {
    process.env.EVALS_PROVIDER = "deepseek";
    process.env.EVALS_MODEL = "deepseek-v4-pro";
    process.env.DEEPSEEK_API_KEY = "eval-key";
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    try {
      const result = await build().generate("Return JSON with ok set to true.");
      expect(result.text).toBe('{"ok":true}');
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.model).toBe("deepseek-v4-pro");
      expect(body.thinking).toEqual({ type: "disabled" });
    } finally {
      restore();
    }
  });
});
