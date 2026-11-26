import { createOpenAI } from "@ai-sdk/openai";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { APICallError, wrapLanguageModel, type LanguageModel } from "ai";
import { z } from "zod";
import { CHATGPT_RECOVERY_MESSAGE } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import type { ChatGptRequestUsage } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import type { OpenAiReasoningLevel } from "@raceiq/shared/integrations/ai/openai-reasoning";

const baseURL = "https://api.openai.com/v1";
const namespace = "raceiq";
const unsupported = [
  "background", "conversation", "include", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
  "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id", "reasoning",
];
const payload = z.looseObject({ stream: z.literal(true), store: z.boolean().optional(), input: z.array(z.looseObject({})) });
const tool = z.looseObject({ type: z.literal("function"), name: z.string() });
const streamEvent = z.looseObject({ type: z.string(), response: z.looseObject({ error: z.unknown().optional() }).optional() });
const streamError = z.object({ code: z.string().optional() });
const tokenCount = z.number().int().nonnegative();
const completedResponse = z.object({
  model: z.string().min(1),
  usage: z.object({
    input_tokens: tokenCount,
    input_tokens_details: z.object({ cached_tokens: tokenCount }),
    output_tokens: tokenCount,
  }),
});

function readCompletedUsage(response: unknown): ChatGptRequestUsage | null {
  const parsed = completedResponse.safeParse(response);
  if (!parsed.success) return null;
  const { model, usage } = parsed.data;
  const cachedInputTokens = usage.input_tokens_details.cached_tokens;
  if (cachedInputTokens > usage.input_tokens) return null;
  return { model, inputTokens: usage.input_tokens, cachedInputTokens, outputTokens: usage.output_tokens };
}

function providerStreamError(error: unknown, status?: number): Error {
  const result = streamError.safeParse(error);
  const code = result.success ? result.data.code : undefined;
  if (status === 401 || code === "reauth_required") return new Error(CHATGPT_RECOVERY_MESSAGE.reauth_required);
  if (status === 429 || code === "subscription_sharing_usage_limit_exceeded" || code === "usage_limit") return new Error(CHATGPT_RECOVERY_MESSAGE.usage_limit);
  if (status === 403 || code === "subscription_sharing_usage_unavailable" || code === "plan_unavailable") return new Error(CHATGPT_RECOVERY_MESSAGE.plan_unavailable);
  return new Error(CHATGPT_RECOVERY_MESSAGE.incomplete);
}

export function createChatGptSubscriptionModel(
  model: string,
  getGrant: () => Promise<{ accessToken: string; signal?: AbortSignal }>,
  upstream: FetchFunction = fetch,
  options?: {
    onUsage?: (usage: ChatGptRequestUsage | null) => void;
    reasoningEffort?: OpenAiReasoningLevel;
  },
): Exclude<LanguageModel, string> {
  const subscriptionFetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url !== `${baseURL}/responses` || request.method !== "POST") throw new Error("Unexpected ChatGPT model request.");
    const body = payload.parse(await request.json());
    for (const field of unsupported) delete body[field];
    if (options?.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };
    body.store = false;
    for (const item of body.input) {
      if (item.type === "item_reference") throw new Error("ChatGPT requires explicit conversation history.");
      if (item.type === "function_call") item.namespace = namespace;
      if (item.role === "system") item.role = "developer";
    }
    if (Array.isArray(body.tools) && body.tools.length) {
      body.tools = [{ type: "namespace", name: namespace, description: "RaceIQ tools", tools: z.array(tool).parse(body.tools) }];
      const choice = body.tool_choice;
      if (choice && typeof choice === "object" && "type" in choice && choice.type === "function") body.tool_choice = { ...choice, namespace };
    }
    const grant = await getGrant();
    const signal = grant.signal ? AbortSignal.any([grant.signal, request.signal]) : request.signal;
    const response = await upstream(`${baseURL}/responses`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${grant.accessToken}`, "Content-Type": "application/json" },
    });
    if (response.ok) return response;
    const code = response.status === 401 ? "reauth_required" : response.status === 403 ? "plan_unavailable" : response.status === 429 ? "usage_limit" : "upstream_unavailable";
    await response.body?.cancel().catch(() => undefined);
    return Response.json({ error: { message: code, code } }, { status: response.status });
  }) as FetchFunction;
  return wrapLanguageModel({
    model: createOpenAI({ baseURL, apiKey: "managed-by-raceiq", fetch: subscriptionFetch }).responses(model),
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        includeRawChunks: true,
        providerOptions: { ...params.providerOptions, openai: {
          ...params.providerOptions?.openai, store: false, systemMessageMode: "developer",
        } },
      }),
      wrapStream: async ({ doStream }) => {
        const result = await Promise.resolve(doStream()).catch((error: unknown) => {
          if (APICallError.isInstance(error)) throw providerStreamError(error.data, error.statusCode);
          throw providerStreamError(null);
        });
        let completed = false;
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              if (part.type === "raw") {
                const event = streamEvent.safeParse(part.rawValue);
                if (!event.success) return;
                if (event.data.type === "response.completed" && !completed) {
                  completed = true;
                  options?.onUsage?.(readCompletedUsage(
                    part.rawValue && typeof part.rawValue === "object" && "response" in part.rawValue
                      ? part.rawValue.response
                      : undefined,
                  ));
                }
                if (event.data.type === "response.failed" || event.data.type === "response.incomplete" || event.data.type === "error") {
                  controller.error(providerStreamError(event.data.response?.error ?? event.data));
                }
                return;
              }
              if (part.type === "error" || (part.type === "finish" && !completed)) {
                controller.error(providerStreamError(null));
                return;
              }
              controller.enqueue(part);
            },
            flush(controller) {
              if (!completed) controller.error(providerStreamError(null));
            },
          })),
        };
      },
    },
  });
}