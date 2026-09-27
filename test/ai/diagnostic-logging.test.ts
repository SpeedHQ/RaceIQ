import { describe, expect, test } from "bun:test";
import { normalizeDiagnostic, withLlmDiagnostics } from "../../server/ai/diagnostic-logging";
import { runGeminiRequest, runOpenAiCompatible } from "../../server/ai/providers";
import { readRecentLogText } from "../../server/runtime/logger";

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

describe("provider failure diagnostics", () => {
  const failures = [
    { name: "transport", fetch: async () => { throw new Error("diagnostic connection refused"); } },
    { name: "json", fetch: async () => new Response("not json") },
    { name: "empty", fetch: async () => Response.json({}) },
    { name: "http", fetch: async () => new Response("diagnostic upstream failure", { status: 503 }) },
  ];

  for (const failure of failures) {
    test(`exports ${failure.name} errors for both providers without duplicates`, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(failure.fetch, { preconnect: originalFetch.preconnect });
      try {
        for (const provider of ["gemini", "openai-compatible"] as const) {
          const prompt = `diagnostic-${provider}-${failure.name}-${crypto.randomUUID()}`;
          let thrown: unknown;
          try {
            if (provider === "gemini") {
              await runGeminiRequest({ prompt, apiKey: "diagnostic-test-key" });
            } else {
              await runOpenAiCompatible({ prompt, endpoint: "http://localhost:1234/v1" });
            }
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(Error);
          const line = readRecentLogText().split("\n")
            .find((candidate) => candidate.includes(prompt) && candidate.includes('"event":"llm-error"'));
          expect(line).toBeDefined();
          expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z ERROR \[raceiq\] llm-error\t/);
          const event = JSON.parse(line!.slice(line!.indexOf("\t") + 1));
          expect(event.provider).toBe(provider);
          expect(event.error.message).toBe((thrown as Error).message);
          if (failure.name === "http") {
            expect(event.error.responseBody).toBe("diagnostic upstream failure");
          }
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
