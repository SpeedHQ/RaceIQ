import { describe, expect, mock, test } from "bun:test";
import type { AppSettings } from "../server/settings";

const secrets: Record<string, string> = {};
mock.module("../server/keystore", () => ({
  getSecret: async (key: string) => secrets[key] ?? "",
}));

const { resolveAi } = await import("../server/ai/ai-runtime");
const { AiProviderError } = await import("../server/ai/provider-error");

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    onboardingComplete: false,
    driverName: "",
    udpPort: 5301,
    unit: "metric",
    temperatureUnit: "C",
    language: "en",
    aiProvider: "",
    aiModel: "",
    aiThinkingBudget: null,
    chatProvider: "",
    chatModel: "",
    chatThinkingBudget: null,
    autoTuneProvider: "",
    autoTuneModel: "",
    driverProfileBackgroundEnabled: false,
    driverProfileProvider: "",
    driverProfileModel: "",
    driverProfileThinkingBudget: null,
    localEndpoint: "http://localhost:1234/v1",
    wsRefreshRate: "60",
    renderFpsCap: 60,
    cacheMaxMB: 256,
    hiddenGames: [],
    launchOnLogin: false,
    communityTunesVersion: null,
    communityTunesSyncedAt: null,
    ...overrides,
  };
}

describe("resolveAi", () => {
  test("resolves Gemini and OpenAI without exposing credentials", async () => {
    secrets["gemini-api-key"] = "gemini-secret";
    secrets["openai-api-key"] = "openai-secret";

    const gemini = await resolveAi("analysis", settings({ aiProvider: "gemini", aiModel: "" }));
    const openai = await resolveAi("analysis", settings({ aiProvider: "openai", aiModel: "custom-model" }));

    expect(gemini.provider).toBe("gemini");
    expect(gemini.model).toBe("gemini-flash-latest");
    expect(openai.provider).toBe("openai");
    expect(openai.model).toBe("custom-model");
    expect("apiKey" in gemini).toBe(false);
    expect("apiKey" in openai).toBe(false);
    expect(JSON.stringify(gemini)).not.toContain("gemini-secret");
    expect(JSON.stringify(openai)).not.toContain("openai-secret");
  });

  test("resolves Local and Codex with provider-specific model fallbacks", async () => {
    const local = await resolveAi("chat", settings({ chatProvider: "local", chatModel: "", localEndpoint: "http://local.test/v1" }));
    const codex = await resolveAi("chat", settings({ chatProvider: "codex", chatModel: "" }));

    expect(local.provider).toBe("local");
    expect(local.model).toBe("local-model");
    expect(codex.provider).toBe("codex");
    expect("createChatResponse" in codex).toBe(false);
    expect("mastraModel" in codex).toBe(false);
  });

  test("throws typed errors for missing provider and API key", async () => {
    secrets["openai-api-key"] = "";
    const noProvider = resolveAi("analysis", settings());
    const noKey = resolveAi("analysis", settings({ aiProvider: "openai" }));

    await expect(noProvider).rejects.toBeInstanceOf(AiProviderError);
    await expect(noProvider).rejects.toMatchObject({ code: "missing-provider" });
    await expect(noKey).rejects.toMatchObject({ code: "missing-api-key", provider: "openai" });
  });

  test("rejects unsupported providers and exposes no chat operation for HTTP adapters", async () => {
    const unsupported = resolveAi("analysis", settings({ aiProvider: "unsupported" as never }));
    await expect(unsupported).rejects.toMatchObject({ code: "unsupported-provider" });

    secrets["gemini-api-key"] = "gemini-secret";
    const gemini = await resolveAi("chat", settings({ chatProvider: "gemini" }));
    expect("createChatResponse" in gemini).toBe(false);
    expect("mastraModel" in gemini).toBe(false);
  });

  test("isolates concurrent transport credentials and endpoints", async () => {
    secrets["gemini-api-key"] = "gemini-a";
    secrets["openai-api-key"] = "openai-b";
    const before = {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      googleKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    };
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
      await Promise.resolve();
      return url.includes("generativelanguage.googleapis.com")
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "gemini response" }] } }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "openai response" } }] }), { status: 200 });
    };
    try {
      const [gemini, openai] = await Promise.all([
        resolveAi("analysis", settings({ aiProvider: "gemini", aiModel: "gemini-a" })),
        resolveAi("chat", settings({ chatProvider: "openai", chatModel: "openai-b" })),
      ]);
      await Promise.all([
        gemini.generateText({ prompt: "gemini prompt" }),
        openai.generateText({ prompt: "openai prompt" }),
      ]);

      expect(requests).toHaveLength(2);
      expect(requests.find((request) => String(request.url).includes("generativelanguage.googleapis.com"))).toMatchObject({
        url: expect.stringContaining("key=gemini-a"),
        authorization: undefined,
      });
      expect(requests.find((request) => String(request.url).includes("api.openai.com/v1/chat/completions"))).toMatchObject({
        authorization: "Bearer openai-b",
      });
      expect(process.env.OPENAI_API_KEY).toBe(before.apiKey);
      expect(process.env.OPENAI_BASE_URL).toBe(before.baseUrl);
      expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe(before.googleKey);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("carries Gemini thinking budget into request-local generation options", async () => {
    secrets["gemini-api-key"] = "gemini-thinking";
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "plain response" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const resolved = await resolveAi("analysis", settings({
        aiProvider: "gemini",
        aiThinkingBudget: 777,
      }));
      await resolved.generateText({ prompt: "hello" });
      expect(requestBody?.generationConfig).toMatchObject({
        thinkingConfig: { thinkingBudget: 777, includeThoughts: false },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
