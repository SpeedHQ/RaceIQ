import { describe, expect, test } from "bun:test";
import { normalizeDiagnostic, withLlmDiagnostics } from "../../server/ai/diagnostic-logging";

describe("diagnostic normalization", () => {
  test("redacts credentials while retaining nested payloads", () => {
    const value: Record<string, unknown> = { prompt: "user text", apiKey: "secret", nested: { token: "x", count: 1n } };
    value.self = value;
    expect(normalizeDiagnostic(value)).toEqual({ prompt: "user text", apiKey: "<REDACTED>", nested: { token: "<REDACTED>", count: "1" }, self: "[Circular]" });
  });
});

  test("preserves wrapped result and thrown errors", async () => {
    const result = await withLlmDiagnostics(
      { provider: "test", model: "m", operation: "op", request: { prompt: "hello" } },
      async () => ({ answer: "ok" }),
    );
    expect(result).toEqual({ answer: "ok" });
    await expect(withLlmDiagnostics(
      { provider: "test", model: "m", operation: "op", request: {} },
      async () => { throw new Error("failure"); },
    )).rejects.toThrow("failure");
  });
