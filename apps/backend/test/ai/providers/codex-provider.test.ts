import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CodexProviderAdapter } from "../../../src/ai/provider-adapters";
import { resolveAi } from "../../../src/ai/ai-runtime";
import { runAiStructured } from "../../../src/ai/model-provider";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getMastraModelId } from "@raceiq/backend-core/ai/chat-agent";

test("Codex provider generates structured analysis through the isolated CLI without inventing cost or an output cap", async () => {
  const adapter = new CodexProviderAdapter({
    feature: "analysis",
    model: "gpt-6.1-sol",
    command: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "provider"],
  });
  const result = await adapter.generateStructured({
    system: "SYSTEM_CONTEXT",
    prompt: "LAP_CONTEXT",
    maxOutputTokens: 32768,
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  });
  expect(result.analysis).toBe('{"answer":"fixture analysis"}');
  expect(result.usage).toMatchObject({ inputTokens: 123, outputTokens: 42, costUsd: null, model: "gpt-6.1-sol" });
  expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.diagnostics).toMatchObject({
    provider: "codex",
    runtimeVersion: "0.164.0",
    status: "completed",
    budget: { requestedOutputTokens: 32768, effectiveOutputTokens: null, supported: false },
    usage: { cachedInputTokens: 0, reasoningOutputTokens: 2, costUsd: null },
  });
});

test("Codex login failures retain actionable identity without falling back to an API-key account", async () => {
  const adapter = new CodexProviderAdapter({
    feature: "analysis",
    model: "gpt-6.1-sol",
    command: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "api-key"],
  });
  await expect(adapter.generateText({ prompt: "fixture" })).rejects.toMatchObject({ code: "not-signed-in", statusCode: 401, provider: "codex", isRetryable: false });
});

test("an explicitly missing Codex executable never falls back to another installation or provider", async () => {
  await expect(resolveAi("analysis", { ...loadSettings(), aiProvider: "codex", aiModel: "gpt-6.1-sol", codexExecutable: "/raceiq-fixture-no-such-install/codex" })).rejects.toMatchObject({
    code: "cli-unavailable",
    provider: "codex",
  });
});

test("cancelled Codex requests retain cancellation identity without launching another provider", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = new CodexProviderAdapter({ feature: "analysis", model: "gpt-6.1-sol", command: ["raceiq-no-such-cli"] });
  await expect(adapter.generateText({ prompt: "fixture", signal: controller.signal })).rejects.toMatchObject({ code: "cancelled", provider: "codex", statusCode: 499, isRetryable: false });
});

test("Codex cannot fall through legacy API-key model routing", () => {
  expect(() => getMastraModelId("codex", "gpt-6.1-sol")).toThrow("Codex");
});

test("selected Codex analysis reaches structured generation without an API key or Mastra fallback", async () => {
  const ai = await resolveAi(
    "analysis",
    { ...loadSettings(), aiProvider: "codex", aiModel: "gpt-6.1-sol" },
    {
      codexCommand: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "success"],
    },
  );
  const result = await runAiStructured(ai, { prompt: "LAP_CONTEXT", schema: { type: "object" } }, async () => {
    throw new Error("Codex must not use an API-key model fallback");
  });
  expect(ai.provider).toBe("codex");
  expect(result.analysis).toBe('{"answer":"fixture analysis"}');
  expect(result.usage.costUsd).toBeNull();
});
