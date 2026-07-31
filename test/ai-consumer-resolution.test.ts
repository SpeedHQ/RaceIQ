import { describe, expect, mock, test } from "bun:test";
import type { AppSettings } from "../server/settings";
import { compareEngineerPersona } from "../server/ai/compare-engineer";

const secrets: Record<string, string> = {};
mock.module("../server/keystore", () => ({
  getSecret: async (key: string) => secrets[key] ?? "",
}));

const { resolveAi } = await import("../server/ai/ai-runtime");

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

describe("AI consumer feature resolution", () => {
  test("uses each consumer's dedicated provider and model settings", async () => {
    const resolved = await Promise.all([
      resolveAi("analysis", settings({ aiProvider: "local", aiModel: "analysis-model" })),
      resolveAi("chat", settings({ chatProvider: "local", chatModel: "chat-model" })),
      resolveAi("autoTune", settings({ autoTuneProvider: "local", autoTuneModel: "tune-model" })),
      resolveAi("driverProfile", settings({ driverProfileProvider: "local", driverProfileModel: "profile-model" })),
      resolveAi("compaction", settings({ chatProvider: "local", chatModel: "compact-model" })),
    ]);

    expect(resolved.map((ai) => [ai.feature, ai.provider, ai.model])).toEqual([
      ["analysis", "local", "analysis-model"],
      ["chat", "local", "chat-model"],
      ["autoTune", "local", "tune-model"],
      ["driverProfile", "local", "profile-model"],
      ["compaction", "local", "compact-model"],
    ]);
  });

  test("auto-tune falls back to analysis settings only when its fields are empty", async () => {
    const ai = await resolveAi("autoTune", settings({
      aiProvider: "local",
      aiModel: "analysis-model",
      autoTuneProvider: "",
      autoTuneModel: "",
    }));

    expect(ai.provider).toBe("local");
    expect(ai.model).toBe("analysis-model");
  });
  test("keeps analysis resolution independent from chat settings", async () => {
    const ai = await resolveAi("analysis", settings({
      aiProvider: "local",
      aiModel: "analysis-specific",
      chatProvider: "local",
      chatModel: "chat-general",
    }));
    expect(ai.provider).toBe("local");
    expect(ai.model).toBe("analysis-specific");
  });

  test("keeps comparison persona and JSON-language contract in system instructions", () => {
    const persona = compareEngineerPersona("metric", "C", "en", { json: true });
    expect(persona).toContain("COMPARATIVE lap analysis");
    expect(persona).toContain("Units: km/h, meters, bar, °C.");
    expect(persona).toContain("Lap A");
  });

  test("returns typed missing-provider errors for HTTP consumers to map", async () => {
    await expect(resolveAi("chat", settings())).rejects.toMatchObject({
      code: "missing-provider",
    });
  });
});
