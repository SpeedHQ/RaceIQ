import { afterEach, describe, expect, test } from "bun:test";
import { requestTuneIntents } from "@raceiq/backend-core/ai/tune-intent";
import type { TuneSymptoms } from "@raceiq/backend-core/ai/tune-symptoms";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { setSecret } from "@raceiq/backend-core/runtime/platform/keystore";

type CapturedRequest = { url: string; init: RequestInit };

const symptoms: TuneSymptoms = {
  corners: [],
  aggregate: {
    balance: "understeer",
    understeerCorners: ["T5"],
    oversteerCorners: [],
    lockupCorners: [],
    bottomingCorners: [],
    tyrePressure: null,
    tyreTemp: null,
    damper: null,
    weightTransfer: null,
  },
};

function installFetchStub(requests: CapturedRequest[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ summary: "ok", intents: [] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

describe("requestTuneIntents with an OpenAI-compatible endpoint", () => {
  const original = loadSettings();
  afterEach(async () => {
    saveSettings(original);
    await setSecret("openai-compatible-api-key", "");
  });

  test("sends Anthropic auth headers and no temperature to Anthropic's endpoint", async () => {
    saveSettings({ ...original, autoTuneProvider: "openai-compatible", autoTuneModel: "claude-haiku-5-5", localEndpoint: "https://api.anthropic.com/v1" });
    await setSecret("openai-compatible-api-key", "test-key");
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests);
    try {
      const result = await requestTuneIntents("acc", symptoms);
      expect(result.intents).toEqual({ summary: "ok", intents: [] });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("https://api.anthropic.com/v1/chat/completions");
      const headers = new Headers(requests[0].init.headers);
      expect(headers.get("authorization")).toBe("Bearer test-key");
      expect(headers.get("x-api-key")).toBe("test-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.response_format.json_schema.name).toBe("tune_intents");
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("reasoning_effort");
    } finally {
      restore();
    }
  });

  test("keeps bearer-only auth and temperature for a local endpoint", async () => {
    saveSettings({ ...original, autoTuneProvider: "openai-compatible", autoTuneModel: "qwen", localEndpoint: "http://local.test/v1" });
    await setSecret("openai-compatible-api-key", "gateway-secret");
    const requests: CapturedRequest[] = [];
    const restore = installFetchStub(requests);
    try {
      await requestTuneIntents("acc", symptoms);
      expect(requests[0].url).toBe("http://local.test/v1/chat/completions");
      const headers = new Headers(requests[0].init.headers);
      expect(headers.get("authorization")).toBe("Bearer gateway-secret");
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.has("anthropic-version")).toBe(false);
      expect(JSON.parse(String(requests[0].init.body)).temperature).toBe(0.3);
    } finally {
      restore();
    }
  });
});
