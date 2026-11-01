import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CodexProviderAdapter, OpenAiCompatibleProviderAdapter, resolvedAiFromAdapter } from "../../../src/ai/provider-adapters";
import { resolveAi } from "../../../src/ai/ai-runtime";
import { runAiStructured } from "../../../src/ai/model-provider";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getMastraModelId } from "@raceiq/backend-core/ai/chat-agent";
import { generateInputsComparison } from "../../../src/ai/generate-inputs-comparison";
import { withAnalysisInstructions } from "@raceiq/shared/integrations/ai/analysis-instructions";
import type { InputsCompareResult } from "@raceiq/backend-core/ai/inputs-compare-prompt";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findCodexExecutable } from "../../../src/ai/codex/executable";

test.skipIf(process.platform !== "darwin")("npm Codex discovery uses its native binary without Node or a shell PATH", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-codex-install-"));
  const packageRoot = join(directory, "codex");
  const launcher = join(packageRoot, "bin", "codex.js");
  const platformPackage = `@openai/codex-darwin-${process.arch}`;
  const platformRoot = join(packageRoot, "node_modules", platformPackage);
  const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const native = join(platformRoot, "vendor", triple, "bin", "codex");
  try {
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    mkdirSync(join(platformRoot, "vendor", triple, "bin"), { recursive: true });
    writeFileSync(launcher, "#!/usr/bin/env node\nthrow new Error('Wrapper must not run');\n");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.164.0", bin: { codex: "bin/codex.js" }, optionalDependencies: { [platformPackage]: `npm:@openai/codex@0.164.0-darwin-${process.arch}` } }));
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: `0.164.0-darwin-${process.arch}` }));
    writeFileSync(native, "#!/bin/sh\nprintf 'codex-cli 0.164.0\\n'\n");
    chmodSync(launcher, 0o755);
    chmodSync(native, 0o755);
    expect(findCodexExecutable(launcher)).toBe(realpathSync(native));
    const child = Bun.spawn([findCodexExecutable(launcher)!, "--version"], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("codex-cli 0.164.0\n");
    expect(await child.exited).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Codex comparison carries persona, saved instructions and schema through the real provider boundary", async () => {
  const adapter = new CodexProviderAdapter({ feature: "analysis", model: "gpt-6.1-sol", command: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "comparison"] });
  const result = await generateInputsComparison(adapter, withAnalysisInstructions("Aligned inputs", "compare", "Focus on throttle pickup."), { ...loadSettings(), comparisonMaxOutputTokens: 65_536 }, async () => { throw new Error("Must not fall back to Mastra"); });
  expect(result.object).toMatchObject({ verdict: "Lap A is faster", coaching: [{ targetLap: "B" }] });
  expect(result.usage).toMatchObject({ outputTokens: 42, costUsd: null });
  expect(result.diagnostics?.budget).toMatchObject({ requestedOutputTokens: 65_536, effectiveOutputTokens: null, supported: false });
});

test("comparison keeps the bound API model and total multi-step usage for existing providers", async () => {
  const ai = resolvedAiFromAdapter(new OpenAiCompatibleProviderAdapter({ feature: "analysis", model: "fixture-model", thinkingBudget: null, endpoint: "http://127.0.0.1:1/v1", apiKey: "" }));
  const object: InputsCompareResult = { verdict: "Similar laps", segments: [{ name: "T1", deltaSeconds: 0, throttle: "Similar", brake: "Similar", steering: "Similar", action: "Keep 100% throttle", severity: "minor" }], coaching: [] };
  const result = await generateInputsComparison(ai, "Comparison context", { ...loadSettings(), comparisonMaxOutputTokens: 16_384 }, async (prompt, options) => {
    expect(prompt).toBe("Comparison context");
    expect(options.requestContext).toBeDefined();
    expect(options.structuredOutput).toMatchObject({ jsonPromptInjection: true });
    expect(options.modelSettings).toMatchObject({ maxOutputTokens: 16_384 });
    return { object, usage: { inputTokens: 1, outputTokens: 2 }, totalUsage: { inputTokens: 100, outputTokens: 20 } };
  });
  expect(result.object).toEqual(object);
  expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
});

test("comparison rejects an invalid provider response before persistence", async () => {
  const adapter = new CodexProviderAdapter({ feature: "analysis", model: "gpt-6.1-sol", command: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "success"] });
  await expect(generateInputsComparison(adapter, "Comparison context", loadSettings(), async () => { throw new Error("Must not fall back"); })).rejects.toThrow("invalid comparison structure");
});

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
