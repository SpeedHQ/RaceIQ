import { expect, test } from "bun:test";
import { z } from "zod";
import { AnthropicProviderAdapter } from "@raceiq/assistant/ai/provider-adapters";

const errorResponse = (status: number) => new Response(JSON.stringify({
  type: "error",
  error: { type: status === 401 ? "authentication_error" : "overloaded_error", message: "provider failure" },
}), { status, headers: { "content-type": "application/json" } });

function messageResponse(text: string): Response {
  return new Response(JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 1 },
  }), { headers: { "content-type": "application/json" } });
}

async function withFetch(respond: (attempt: number, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => respond(++attempts, init),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  try {
    await run();
    return attempts;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function adapter() {
  return new AnthropicProviderAdapter({ feature: "autoTune", model: "claude-test", apiKey: "request-key" });
}

for (const status of [529, 429]) {
  test(`Anthropic retries ${status} and preserves request credentials`, async () => {
    const keys: (string | null)[] = [];
    const attempts = await withFetch((attempt, init) => {
      keys.push(new Headers(init?.headers).get("x-api-key"));
      return attempt === 1 ? errorResponse(status) : messageResponse("recovered");
    }, async () => {
      expect((await adapter().generateText({ prompt: "test" })).analysis).toBe("recovered");
    });
    expect(attempts).toBe(2);
    expect(keys).toEqual(["request-key", "request-key"]);
  });
}

test("Anthropic does not retry unclassified fetch or application errors", async () => {
  for (const error of [
    new DOMException("aborted", "AbortError"),
    new TypeError("invalid input"),
    new TypeError("network error while parsing configuration"),
    new TypeError("Load failed"),
    new TypeError("ConnectionRefused"),
    new TypeError("socket hang up"),
  ]) {
    const attempts = await withFetch(() => { throw error; }, async () => {
      await expect(adapter().generateText({ prompt: "test" })).rejects.toThrow(error.message);
    });
    expect(attempts).toBe(1);
  }
});

test("Anthropic does not wait for an excessive Retry-After", async () => {
  const attempts = await withFetch(() => {
    const response = errorResponse(429);
    response.headers.set("retry-after", "86400");
    return response;
  }, async () => {
    await expect(adapter().generateText({ prompt: "test" })).rejects.toMatchObject({ statusCode: 429 });
  });
  expect(attempts).toBe(1);
});

test("Anthropic stops after transient retry exhaustion and retains error metadata", async () => {
  const attempts = await withFetch(() => errorResponse(529), async () => {
    await expect(adapter().generateText({ prompt: "test" })).rejects.toMatchObject({
      name: "AiProviderError",
      code: "upstream",
      provider: "anthropic",
      modelId: "claude-test",
      statusCode: 529,
      isRetryable: true,
      responseBody: expect.stringContaining("provider failure"),
    });
  });
  expect(attempts).toBe(3);
});

test("Anthropic authentication errors are not retried", async () => {
  const attempts = await withFetch(() => errorResponse(401), async () => {
    await expect(adapter().generateText({ prompt: "test" })).rejects.toMatchObject({
      name: "AiProviderError",
      code: "upstream",
      provider: "anthropic",
      modelId: "claude-test",
      statusCode: 401,
      isRetryable: false,
      message: "Invalid API key. Check your key in Settings.",
    });
  });
  expect(attempts).toBe(1);
});

test("Anthropic structured generation retries transient failures", async () => {
  const attempts = await withFetch((attempt) => attempt === 1 ? errorResponse(529) : messageResponse('{"value":"recovered"}'), async () => {
    const result = await adapter().generateStructured({ prompt: "test", schema: z.object({ value: z.string() }) });
    expect(JSON.parse(result.analysis)).toEqual({ value: "recovered" });
  });
  expect(attempts).toBe(2);
});
