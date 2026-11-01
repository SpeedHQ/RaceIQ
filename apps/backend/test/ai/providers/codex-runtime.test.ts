import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { discoverCodex, runCodexGeneration } from "../../../src/ai/codex/runtime";

function command(scenario: string): string[] {
  return [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), scenario];
}

test("ignores another turn's notifications received before turn acknowledgement", async () => {
  const result = await runCodexGeneration({ command: command("foreign-before-ack"), model: "gpt-6.1-sol", prompt: "fixture" });
  expect(result.text).toBe('{"answer":"fixture analysis"}');
  expect(result.usage).toMatchObject({ inputTokens: 123, outputTokens: 42 });
});

test("rejects an excessive pre-acknowledgement notification stream", async () => {
  await expect(runCodexGeneration({ command: command("early-overflow"), model: "gpt-6.1-sol", prompt: "fixture" })).rejects.toMatchObject({ code: "generation-failed" });
});

test("metadata discovery exposes only a verified model without starting a thread or inference", async () => {
  expect(await discoverCodex(command("success"))).toEqual({ state: "ready", models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] });
  expect(await discoverCodex(command("api-key"))).toEqual({ state: "not-signed-in", models: [] });
  expect(await discoverCodex(command("unsupported"))).toEqual({ state: "unsupported-runtime", models: [] });
  expect(await discoverCodex(command("unverified-model"))).toEqual({ state: "unsupported-runtime", models: [] });
});

test("rejects an unverified CLI version before supplying telemetry", async () => {
  await expect(runCodexGeneration({ command: command("unsupported"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "unsupported-runtime" });
});

test("refuses an API-key account instead of silently using billable API credentials", async () => {
  await expect(runCodexGeneration({ command: command("api-key"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "not-signed-in" });
});

test("refuses generation when the child reports an excluded capability enabled", async () => {
  await expect(runCodexGeneration({ command: command("unsafe-feature"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "unsafe-runtime" });
});

test("generates through the isolated profile and reports measured usage without inventing an output cap or cost", async () => {
  const result = await runCodexGeneration({
    command: command("success"),
    model: "gpt-6.1-sol",
    prompt: "PRIVATE_TELEMETRY",
    requestedOutputTokens: 32768,
    effort: "low",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  });
  expect(result).toMatchObject({
    text: '{"answer":"fixture analysis"}',
    status: "completed",
    usage: { inputTokens: 123, cachedInputTokens: 0, outputTokens: 42, reasoningOutputTokens: 2, costUsd: null },
    budget: { requestedOutputTokens: 32768, effectiveOutputTokens: null, supported: false },
  });
});

test("does not treat missing capability metadata as proof of isolation", async () => {
  await expect(runCodexGeneration({ command: command("missing-features"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "unsafe-runtime" });
});

test("rejects MCP tools exposed on the actual thread before supplying telemetry", async () => {
  await expect(runCodexGeneration({ command: command("leaked-mcp"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "unsafe-runtime" });
});

test("keeps missing usage unknown instead of inventing zero tokens or subscription cost", async () => {
  const result = await runCodexGeneration({ command: command("missing-usage"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" });
  expect(result.usage).toEqual({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, costUsd: null });
});

test("does not promote a failed turn's partial text to completed analysis", async () => {
  await expect(runCodexGeneration({ command: command("failed"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "generation-failed" });
});

test("a child exiting after acknowledgement fails promptly rather than waiting for the generation deadline", async () => {
  await expect(runCodexGeneration({ command: command("exit-after-ack"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY", timeoutMs: 60000 })).rejects.toMatchObject({ code: "generation-failed" });
}, 3000);

test("does not mix another turn's usage into the measured analysis", async () => {
  const result = await runCodexGeneration({ command: command("foreign-usage"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" });
  expect(result.usage).toMatchObject({ inputTokens: 123, outputTokens: 42 });
});

test("an already cancelled request never launches the configured executable", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(runCodexGeneration({ command: ["raceiq-does-not-exist"], model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY", signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
});

test("cancellation also stops a stalled account preflight", async () => {
  const controller = new AbortController();
  const pending = runCodexGeneration({ command: command("stall-account"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY", signal: controller.signal }).catch((failure: unknown) => failure);
  const abort = setTimeout(() => controller.abort(), 50);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve({ code: "test-deadline" }), 1500);
      }),
    ]);
    expect(result).toMatchObject({ code: "cancelled" });
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
    await pending;
  }
}, 15000);

test("a partial-answer item is not presented as the final structured analysis", async () => {
  await expect(runCodexGeneration({ command: command("partial-only"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "generation-failed" });
});

test("refuses newly appearing MCP servers even before they expose any tools", async () => {
  await expect(runCodexGeneration({ command: command("new-server"), model: "gpt-6.1-sol", prompt: "PRIVATE_TELEMETRY" })).rejects.toMatchObject({ code: "unsafe-runtime" });
});
