import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { getMastraModelId } from "@raceiq/assistant/mastra/model";
import { getTrackGuideTool } from "@raceiq/assistant/mastra/tools/track-guide";
import { getAnthropicModelsDetailed, getProviders } from "@raceiq/assistant/ai/providers";
import { AnthropicProviderAdapter } from "@raceiq/assistant/ai/provider-adapters";

type CapturedRequest = { url: string; init: RequestInit };

function installFetchStub(requests: CapturedRequest[], body: unknown) {
  const responseFor = typeof body === "function" ? body : () => body;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(responseFor(requests.length)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

const completion = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "{\"answer\":\"ok\"}" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
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

  test("uses native Anthropic messages with request-scoped keys for direct and Mastra calls", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, completion);
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8787";
    try {
      const adapter = new AnthropicProviderAdapter({ feature: "chat", model: "claude-haiku-5-5", apiKey: "direct-key" });
      const agent = new Agent({ id: "test-anthropic", name: "Test", instructions: "Answer.", model: getMastraModelId({ provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "agent-key" }) });
      const direct = await adapter.generateText({ prompt: "ping" });
      const structured = await adapter.generateStructured({
        prompt: "ping",
        schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      });
      await agent.generate("ping");
      expect(direct.analysis).toBe("{\"answer\":\"ok\"}");
      expect(JSON.parse(structured.analysis)).toEqual({ answer: "ok" });
      expect(requests).toHaveLength(3);
      for (const [index, request] of requests.entries()) {
        expect(request.url).toBe("https://api.anthropic.com/v1/messages");
        const headers = new Headers(request.init.headers);
        expect(headers.get("x-api-key")).toBe(index === 2 ? "agent-key" : "direct-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        const body = JSON.parse(String(request.init.body));
        expect(body.model).toBe(index === 2 ? "claude-sonnet-5-5" : "claude-haiku-5-5");
        expect(body).not.toHaveProperty("reasoning_effort");
      }
    } finally {
      restore();
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }
  });

  test("Mastra executes a RaceIQ tool and sends its result to Claude", async () => {
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests, (attempt: number) => attempt === 1 ? {
      ...completion,
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_track", name: "get_track_guide", input: { trackName: "Monza" } }],
    } : { ...completion, id: "msg_final", content: [{ type: "text", text: "Monza guide found." }] });
    try {
      const agent = new Agent({
        id: "anthropic-tool-test", name: "Track guide", instructions: "Use the track guide.",
        model: getMastraModelId({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: "agent-key" }),
        tools: { get_track_guide: getTrackGuideTool },
      });
      const result = await agent.generate("Look up Monza.", { maxSteps: 2 });
      expect(result.text).toBe("Monza guide found.");
      expect(requests).toHaveLength(2);
      const followup = JSON.parse(String(requests[1].init.body));
      expect(followup.messages).toContainEqual(expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_track" })]),
      }));
      expect(JSON.stringify(followup.messages)).toContain('\\"available\\":true');
    } finally {
      restore();
    }
  });

  test("rejects a missing request key instead of using an environment key", () => {
    expect(() => getMastraModelId("anthropic", "claude-sonnet-5-5")).toThrow("API key not set");
  });
});
