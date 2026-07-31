import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";

import { loadSettings, saveSettings, type AppSettings } from "../server/settings";
import { resolveAi } from "../server/ai/ai-runtime";
import { OpenAiProviderAdapter } from "../server/ai/provider-adapters";
import { createModelContext, getModel, runAiChat, runAiStructured, runAiText } from "../server/ai/model-provider";
import { setResolvedAiInternals } from "../server/ai/resolved-ai-internals";
import { modelFromRequestContext } from "../mastra/model";

const originalSettings = loadSettings();

function settings(overrides: Partial<AppSettings>): AppSettings {
  return {
    ...originalSettings,
    aiProvider: "local",
    aiModel: "analysis-model",
    chatProvider: "local",
    chatModel: "chat-model",
    autoTuneProvider: "local",
    autoTuneModel: "auto-tune-model",
    driverProfileProvider: "local",
    driverProfileModel: "driver-profile-model",
    ...overrides,
  };
}

describe("settings-aware model provider", () => {
  beforeEach(() => {
    saveSettings(originalSettings);
  });

  afterEach(() => {
    saveSettings(originalSettings);
  });

  test("reuses model already bound to request context", async () => {
    const ai = await resolveAi("analysis", settings({}));
    const boundContext = createModelContext(ai, new RequestContext());
    const boundModel = modelFromRequestContext(boundContext);

    expect(boundModel).toBeDefined();
    expect(await getModel("chat", boundContext)).toBe(boundModel);
  });

  test("resolves model directly from feature settings", async () => {
    saveSettings(settings({ aiModel: "resolved-analysis-model" }));
    const resolved = await getModel("analysis");

    expect(resolved).toBeDefined();
  });

  test("selects independent model for each feature", async () => {
    const analysis = await resolveAi("analysis", settings({ aiModel: "analysis-model" }));
    const chat = await resolveAi("chat", settings({ chatModel: "chat-model" }));
    const analysisContext = createModelContext(analysis, new RequestContext());
    const chatContext = createModelContext(chat, new RequestContext());

    expect(modelFromRequestContext(analysisContext)).not.toBe(modelFromRequestContext(chatContext));
  });

  test("binds explicit provider credentials to Mastra model", () => {
    const adapter = new OpenAiProviderAdapter({
      feature: "analysis",
      model: "gpt-test",
      apiKey: "request-scoped-key",
    });

    expect(adapter.mastraModel).toBeDefined();
    expect(typeof adapter.mastraModel).toBe("object");
  });

  test("returns no Mastra context for Codex", async () => {
    const codex = await resolveAi("chat", settings({ chatProvider: "codex", chatModel: "codex-model" }));

    expect(createModelContext(codex)).toBeUndefined();
  });

  test("rejects Codex when Mastra model is requested", async () => {
    saveSettings(settings({ chatProvider: "codex", chatModel: "codex-model" }));
    const codexSettingsContext = new RequestContext();

    await expect(getModel("chat", codexSettingsContext)).rejects.toMatchObject({
      code: "unsupported-operation",
      provider: "codex",
    });
  });
  test("dispatches native Codex chat without running Mastra", async () => {
    const codexAi = {
      feature: "chat" as const,
      provider: "codex" as const,
      model: "codex",
      generateText: async () => ({ analysis: "", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "codex" } }),
      generateStructured: async () => ({ analysis: "", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "codex" } }),
    };
    setResolvedAiInternals(codexAi, {
      createChatResponse: async () => new Response("ok", { status: 200 }),
    });

    const response = await runAiChat(codexAi, { systemPrompt: "", messages: [] }, async () => {
      throw new Error("Mastra must not run");
    });
    expect(response.status).toBe(200);
  });

  test("normalizes Mastra structured output and passes bound context", async () => {
    const openAi = {
      feature: "analysis" as const,
      provider: "openai" as const,
      model: "gpt-4o-mini",
      generateText: async () => ({ analysis: "", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "gpt-4o-mini" } }),
      generateStructured: async () => ({ analysis: "", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "gpt-4o-mini" } }),
    };
    setResolvedAiInternals(openAi, { model: "bound-model" });

    const result = await runAiStructured(openAi, {
      prompt: "test",
      schema: {},
    }, async (context) => {
      expect(modelFromRequestContext(context)).toBe("bound-model");
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 2 } };
    });
    expect(result).toMatchObject({ analysis: "ok", usage: { model: "gpt-4o-mini" } });
  });

  test("rejects Codex comparison centrally before native execution", async () => {
    const codex = await resolveAi("analysis", settings({ aiProvider: "codex", aiModel: "codex-model" }));

    await expect(runAiStructured(codex, {
      prompt: "compare",
      schema: {},
    }, async () => {
      throw new Error("comparison Mastra must not run");
    }, { operation: "comparison" })).rejects.toMatchObject({
      code: "unsupported-operation",
      provider: "codex",
    });
  });

  test("dispatches Codex prose through native text generation", async () => {
    const codex = {
      feature: "analysis" as const,
      provider: "codex" as const,
      model: "codex",
      generateText: async () => ({
        analysis: "prose",
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 0, durationMs: 3, model: "codex" },
      }),
      generateStructured: async () => ({
        analysis: "",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "codex" },
      }),
    };

    const result = await runAiText(codex, { prompt: "consult" }, async () => {
      throw new Error("Mastra must not run");
    });
    expect(result).toMatchObject({ analysis: "prose", usage: { model: "codex" } });
  });

});
