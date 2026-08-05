import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

import { loadSettings } from "../../server/runtime/config/settings";
import { settingsRoutes } from "../../server/routes/settings-routes";

// Follows DATA_DIR so this never mutates the real dev settings.json —
// `bun run test` isolates DATA_DIR to a throwaway directory (see package.json).
const SETTINGS_DIR = process.env.DATA_DIR ?? "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

describe("settings with unit system", () => {
  let originalContent: string | null = null;

  beforeEach(() => {
    if (existsSync(SETTINGS_PATH)) {
      originalContent = readFileSync(SETTINGS_PATH, "utf-8");
    }
  });

  afterEach(() => {
    if (originalContent) {
      writeFileSync(SETTINGS_PATH, originalContent);
    }
  });

  test("loadSettings returns defaults when file has only udpPort (migration)", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 5300 }));
    const settings = loadSettings();
    expect(settings.unit).toBe("metric");
  });

  test("loadSettings migrates legacy speedUnit to unit", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 5300, speedUnit: "mph" }));
    const settings = loadSettings();
    expect(settings.unit).toBe("imperial");
  });

  test("loadSettings strips legacy threshold fields", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      udpPort: 5300,
      tireTempCelsiusThresholds: { cold: 60, warm: 100, hot: 130 },
      tireHealthThresholds: { values: [20, 40, 60, 80] },
      suspensionThresholds: { values: [25, 65, 85] },
    }));
    const loaded = loadSettings() as Record<string, unknown>;
    expect(loaded.udpPort).toBe(5300);
    expect(loaded.tireTempCelsiusThresholds).toBeUndefined();
    expect(loaded.tireHealthThresholds).toBeUndefined();
    expect(loaded.suspensionThresholds).toBeUndefined();
  });

  test("loadSettings migrates removed Codex selections without resetting other settings", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      onboardingComplete: true,
      udpPort: 5300,
      aiProvider: "codex",
      aiModel: "codex-analysis",
      aiThinkingBudget: 12000,
      chatProvider: "codex",
      chatModel: "codex-chat",
      chatThinkingBudget: 8000,
      autoTuneProvider: "codex",
      autoTuneModel: "codex-tune",
      driverProfileProvider: "codex",
      driverProfileModel: "codex-profile",
      driverProfileThinkingBudget: 6000,
      localEndpoint: "http://127.0.0.1:4321/v1",
      hiddenGames: ["ac", "acc"],
    }));

    const settings = loadSettings();

    expect(settings.aiProvider).toBe("");
    expect(settings.aiModel).toBe("");
    expect(settings.chatProvider).toBe("");
    expect(settings.chatModel).toBe("");
    expect(settings.autoTuneProvider).toBe("");
    expect(settings.autoTuneModel).toBe("");
    expect(settings.driverProfileProvider).toBe("");
    expect(settings.driverProfileModel).toBe("");
    expect(settings.aiThinkingBudget).toBe(12000);
    expect(settings.chatThinkingBudget).toBe(8000);
    expect(settings.driverProfileThinkingBudget).toBe(6000);
    expect(settings.onboardingComplete).toBe(true);
    expect(settings.localEndpoint).toBe("http://127.0.0.1:4321/v1");
    expect(settings.hiddenGames).toEqual(["ac", "acc"]);
  });
});

describe("AI model discovery", () => {


  test("keeps local model discovery available when endpoint returns an error", async () => {
    const originalFetch = globalThis.fetch;
    const mockedFetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response("", { status: 503, statusText: "Unavailable" }),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch;
    globalThis.fetch = mockedFetch;
    try {
      const response = await settingsRoutes.request("/api/ai-models?providers=local");
      expect(response.status).toBe(200);
      const body = await response.json() as { local: unknown[]; _errors?: { local?: string | null } };
      expect(body.local).toEqual([]);
      expect(body._errors?.local).toContain("503");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
