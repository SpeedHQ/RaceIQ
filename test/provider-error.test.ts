import { describe, expect, test } from "bun:test";

import { toClientAiError } from "../server/ai/provider-error";

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
