import { expect, spyOn, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createChatGptSubscriptionModel } from "../../../src/ai/chatgpt-subscription-model";
import { consumeMastraGeneration } from "../../../src/ai/stream-mastra-generation";
import { bindMastraModel } from "../../../src/mastra/model";
import { ChatGptSubscriptionAdapter } from "../../../src/ai/chatgpt-subscription-adapter";
import type { ChatGptRequestUsage } from "@raceiq/shared/integrations/ai/chatgpt-subscription";

const model = "gpt-6.2-sol";
const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false };

test.each(["completed", "truncated", "quota"])("requires terminal completion for structured ChatGPT output (%s)", async (outcome) => {
  const text = '{"verdict":"ok"}';
  const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_1", object: "response", status: "completed", created_at: 1, model, output: [item], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    ...(outcome === "completed" ? [{ type: "response.completed", response }] : []),
    ...(outcome === "quota" ? [{ type: "error", code: "subscription_sharing_usage_limit_exceeded", message: "Private upstream details", param: null }] : []),
  ];
  const upstream = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-grant");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model, stream: true, store: false, text: { format: { type: "json_schema", schema } } });
    expect(body).not.toHaveProperty("reasoning");
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch);
  try {
    const adapter = new ChatGptSubscriptionAdapter("analysis", model, {
      accountId: "test-account", signal: new AbortController().signal, token: async () => "test-grant",
    });
    const result = adapter.generateStructured({ prompt: "Give a verdict.", schema });
    if (outcome === "completed") {
      expect(await result).toMatchObject({ analysis: text, usage: { inputTokens: 7, outputTokens: 3, model } });
    } else if (outcome === "quota") {
      await expect(result).rejects.toThrow("ChatGPT plan usage limit reached. Open ChatGPT usage settings.");
    } else {
      await expect(result).rejects.toThrow("ChatGPT did not complete the request");
    }
  } finally {
    upstream.mockRestore();
  }
});

test("Mastra executes a namespaced tool and sends its result in explicit subscription history", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", namespace: "raceiq", name: "track", arguments: '{"id":"spa"}', status: "completed" };
  const answer = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Spa confirmed.", annotations: [] }] };
  let requests = 0;
  const usage: (ChatGptRequestUsage | null)[] = [];
  const executed: string[] = [];
  const upstream = (async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-grant");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ store: false, stream: true, tools: [{ type: "namespace", name: "raceiq", tools: [{ name: "track" }] }] });
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.input).toContainEqual(expect.objectContaining({ role: "user" }));
    const first = ++requests === 1;
    if (!first) {
      expect(requests).toBe(2);
      expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1", namespace: "raceiq", name: "track" }));
      expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: expect.stringContaining("Spa") }));
    }
    const item = first ? call : answer;
    const response = { id: `resp_${requests}`, object: "response", status: "completed", created_at: 1, model, output: [item], usage: { input_tokens: 7, input_tokens_details: { cached_tokens: first ? 0 : 2 }, output_tokens: 3, total_tokens: 10 } };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: first ? { ...call, arguments: "", status: "in_progress" } : { ...answer, content: [], status: "in_progress" } },
      first
        ? { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: call.arguments }
        : { type: "response.output_text.delta", output_index: 0, item_id: answer.id, content_index: 0, delta: "Spa confirmed." },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  const subscription = createChatGptSubscriptionModel(model, async () => ({ accessToken: "test-grant" }), upstream, {
    reasoningEffort: "high", onUsage: (request) => usage.push(request),
  });
  const track = createTool({
    id: "track", description: "Look up a track", inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => { executed.push(id); return { name: "Spa" }; },
  });
  const agent = new Agent({ id: "subscription-tool-test", name: "Track test", instructions: "Look up the track.", model: bindMastraModel(subscription), tools: { track } });
  const result = await consumeMastraGeneration(agent.stream("Look up Spa.", { maxSteps: 2, modelSettings: { maxRetries: 0 } }));
  expect(result.text).toBe("Spa confirmed.");
  expect(executed).toEqual(["spa"]);
  expect(requests).toBe(2);
  expect(usage).toEqual([
    { model, inputTokens: 7, cachedInputTokens: 0, outputTokens: 3 },
    { model, inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 },
  ]);
});
