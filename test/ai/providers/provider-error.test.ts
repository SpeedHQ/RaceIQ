import { describe, expect, test } from "bun:test";

import { toClientAiError } from "../../../server/ai/provider-error";

describe("toClientAiError", () => {
  test("surfaces upstream response body details and retryability", () => {
    const err = {
      message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
      statusCode: 503,
      isRetryable: true,
      provider: "google",
      modelId: "gemma-4-31b-it",
      responseBody: "{\n  \"error\": {\n    \"code\": 503,\n    \"message\": \"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.\",\n    \"status\": \"UNAVAILABLE\"\n  }\n}\n",
    };

    expect(toClientAiError(err)).toEqual({
      message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
      statusCode: 503,
      retryable: true,
      provider: "google",
      modelId: "gemma-4-31b-it",
      upstream: {
        code: 503,
        message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
        status: "UNAVAILABLE",
      },
    });
  });

  test("combines generic provider error with upstream response detail", () => {
    const error = toClientAiError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          code: 400,
          message: "request exceeds available context size",
          type: "exceed_context_size_error",
        },
      }),
    });

    expect(formatClientAiErrorMessage(error)).toBe(
      "Bad Request: request exceeds available context size",
    );
  });

  test("extracts nested engine error from SDK response body", () => {
    const error = toClientAiError({
      message: "OpenAI stream failed before any output was generated",
      responseBody: JSON.stringify({
        message:
          'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request exceeds context size","type":"exceed_context_size_error","n_prompt_tokens":9144,"n_ctx":8192}}',
      }),
    });

    expect(formatClientAiErrorMessage(error)).toBe(
      "OpenAI stream failed before any output was generated: request exceeds context size",
    );

    expect(error.upstream).toMatchObject({
      promptTokens: 9144,
      contextLength: 8192,
    });
  });

  test("falls back when upstream body is missing", () => {
    const out = toClientAiError(new Error("boom"));
    expect(out).toEqual({
      message: "boom",
      statusCode: null,
      retryable: false,
      provider: null,
      modelId: null,
      upstream: null,
    });
  });
});
