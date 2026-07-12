import { describe, expect, test } from "bun:test";

import { chatStreamResponse } from "../server/ai/chat-stream";

type StreamPart = { type: string; payload?: Record<string, unknown>; usage?: Record<string, unknown> };

async function readEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeStream(parts: StreamPart[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
  } as unknown;
}

describe("chatStreamResponse", () => {
  test("forwards structured provider errors to client", async () => {
    const response = chatStreamResponse(Promise.reject({
      message: "Internal error encountered.",
      statusCode: 500,
      isRetryable: true,
      provider: "google",
      modelId: "gemma-4-31b-it",
      responseBody: "{\n  \"error\": {\n    \"code\": 500,\n    \"message\": \"Internal error encountered.\",\n    \"status\": \"INTERNAL\"\n  }\n}\n",
    }));

    const events = await readEvents(response);
    const errorEvent = events.find((e) => e.type === "error");

    expect(errorEvent).toEqual({
      type: "error",
      message: "Internal error encountered.",
      statusCode: 500,
      retryable: true,
      provider: "google",
      modelId: "gemma-4-31b-it",
      upstream: {
        code: 500,
        message: "Internal error encountered.",
        status: "INTERNAL",
      },
    });
  });

  test("retries once on retryable upstream failure", async () => {
    let calls = 0;
    const response = chatStreamResponse(async () => {
      calls += 1;
      if (calls === 1) {
        throw {
          message: "transient",
          statusCode: 500,
          isRetryable: true,
          provider: "google",
        };
      }
      return makeStream([
        { type: "text-delta", payload: { text: "ok" } },
      ]);
    });

    const events = await readEvents(response);

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "text" && e.delta === "ok")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("emits usage when tokens are on top-level stream part", async () => {
    const response = chatStreamResponse(
      makeStream([
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", usage: { promptTokenCount: 123, candidatesTokenCount: 45 } },
      ]),
      { provider: "google", modelId: "gemini-2.0-flash" },
    );

    const events = await readEvents(response);
    const usageEvent = events.find((e) => e.type === "usage");

    expect(usageEvent).toEqual({
      type: "usage",
      inputTokens: 123,
      outputTokens: 45,
      costUsd: 0.00003,
      model: "gemini-2.0-flash",
    });
  });

  test("does not emit thinking status without reasoning events", async () => {
    const response = chatStreamResponse(
      makeStream([
        { type: "text-delta", payload: { text: "ok" } },
      ]),
      { provider: "google", modelId: "gemini-2.0-flash" },
    );
    const events = await readEvents(response);
    const statuses = events.filter((e) => e.type === "status").map((e) => e.state);
    expect(statuses).toEqual(["starting", "generating"]);
  });
});
