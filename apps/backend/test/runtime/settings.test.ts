import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { loadSettings, saveSettings, PartialSettingsSchema } from "@raceiq/backend-core/runtime/config/settings";
import { settingsRoutes, shouldCheckCredentialStatus } from "../../src/routes/settings-routes";
import { getRecordingFrequencyHz, setRecordingFrequencyHz } from "@raceiq/backend-core/runtime/config/recording-frequency";
import { RECORDING_FREQUENCIES_HZ } from "@raceiq/shared/platform/runtime/recording-frequency";
import { udpListener } from "../../src/runtime/udp-listener";

// Follows DATA_DIR so this never mutates the real dev settings.json —
// `bun run test` isolates DATA_DIR to a throwaway directory (see package.json).
const SETTINGS_DIR = process.env.DATA_DIR ?? "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

describe("E2E settings behavior", () => {
  test("skips credential status checks in E2E mode", () => {
    expect(shouldCheckCredentialStatus({ RACEIQ_E2E: "1" })).toBe(false);
    expect(shouldCheckCredentialStatus({ RACEIQ_E2E: "0" })).toBe(true);
  });
});

describe("credential request validation", () => {
  test("rejects unsupported providers and malformed keys before accessing the OS store", async () => {
    for (const body of [
      { provider: 'gemini"; printf unexpected', apiKey: "test" },
      { provider: "../other-account", apiKey: "test" },
      { provider: "gemini", apiKey: 123 },
      { provider: "gemini", apiKey: null },
      { provider: "gemini" },
      { provider: "gemini", apiKey: "test\0key" },
      { provider: "gemini", apiKey: "x".repeat(8193) },
    ]) {
      const response = await settingsRoutes.request("/api/ai-key", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});

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

  test("persists and clears the HUD hostname without changing other settings", () => {
    const before = loadSettings();
    saveSettings({...before, hudHostname: " Race-PC.Example.ts.net "});
    expect(loadSettings().hudHostname).toBe("race-pc.example.ts.net");
    expect(loadSettings().udpPort).toBe(before.udpPort);
    saveSettings({...loadSettings(), hudHostname: ""});
    expect(loadSettings().hudHostname).toBe("");
    expect(PartialSettingsSchema.safeParse({hudHostname: "http://pc.ts.net"}).success).toBe(false);
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

  test("migrates shipped Local provider selections to OpenAI-compatible", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      aiProvider: "local",
      chatProvider: "local",
      autoTuneProvider: "local",
      driverProfileProvider: "local",
      localEndpoint: "https://openrouter.ai/api/v1",
    }));

    const settings = loadSettings();

    expect(settings.aiProvider).toBe("openai-compatible");
    expect(settings.chatProvider).toBe("openai-compatible");
    expect(settings.autoTuneProvider).toBe("openai-compatible");
    expect(settings.driverProfileProvider).toBe("openai-compatible");
    expect(settings.localEndpoint).toBe("https://openrouter.ai/api/v1");
  });
});
describe("driver profile output budget", () => {
  let originalContent: string | null = null;

  beforeEach(() => {
    originalContent = existsSync(SETTINGS_PATH)
      ? readFileSync(SETTINGS_PATH, "utf-8")
      : null;
  });

  afterEach(() => {
    if (originalContent === null) {
      rmSync(SETTINGS_PATH, { force: true });
    } else {
      writeFileSync(SETTINGS_PATH, originalContent);
    }
  });

  test("defaults to 5,000 tokens", () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({}));
    expect(loadSettings().driverProfileMaxOutputTokens).toBe(5_000);
  });

  test("rejects budgets outside supported bounds", () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ driverProfileMaxOutputTokens: 511 }));
    expect(loadSettings().driverProfileMaxOutputTokens).toBe(5_000);
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
      const response = await settingsRoutes.request("/api/ai-models?providers=openai-compatible");
      expect(response.status).toBe(200);
      const body = await response.json() as { "openai-compatible": unknown[]; _errors?: { "openai-compatible"?: string | null } };
      expect(body["openai-compatible"]).toEqual([]);
      expect(body._errors?.["openai-compatible"]).toContain("503");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

describe("recording frequency settings", () => {
  let originalContent: string | null;
  let originalFrequency = getRecordingFrequencyHz();

  beforeEach(() => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    originalContent = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, "utf-8") : null;
    originalFrequency = getRecordingFrequencyHz();
    saveSettings({ ...loadSettings(), udpPort: 5301 });
  });

  afterEach(() => {
    rmSync(`${SETTINGS_PATH}.tmp`, { recursive: true, force: true });
    if (originalContent === null) rmSync(SETTINGS_PATH, { force: true });
    else writeFileSync(SETTINGS_PATH, originalContent);
    setRecordingFrequencyHz(originalFrequency);
  });

  test("defaults old settings to 100 without losing unrelated values", () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ driverName: "Old install", udpPort: 5301 }));
    expect(loadSettings().recordingFrequencyHz).toBe(100);
    expect(loadSettings().driverName).toBe("Old install");
  });

  test("saves each numeric frequency and applies it to active capture", async () => {
    for (const frequencyHz of RECORDING_FREQUENCIES_HZ) {
      const response = await settingsRoutes.request("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingFrequencyHz: frequencyHz }),
      });
      expect(response.status).toBe(200);
      expect(loadSettings().recordingFrequencyHz).toBe(frequencyHz);
      expect(getRecordingFrequencyHz()).toBe(frequencyHz);
    }
    const response = await settingsRoutes.request("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driverName: "Unrelated update" }),
    });
    expect(response.status).toBe(200);
    expect(loadSettings().recordingFrequencyHz).toBe(100);
  });

  test("invalid requests and failed persistence cannot change active frequency", async () => {
    setRecordingFrequencyHz(70);
    for (const value of ["50", 0, 55, 101, null]) {
      expect(PartialSettingsSchema.safeParse({ recordingFrequencyHz: value }).success).toBe(false);
      const response = await settingsRoutes.request("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingFrequencyHz: value }),
      });
      expect(response.status).toBe(400);
      expect(getRecordingFrequencyHz()).toBe(70);
    }
    const before = readFileSync(SETTINGS_PATH, "utf-8");
    mkdirSync(`${SETTINGS_PATH}.tmp`);
    const response = await settingsRoutes.request("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingFrequencyHz: 50 }),
    });
    expect(response.status).toBe(500);
    expect(getRecordingFrequencyHz()).toBe(70);
    expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(before);
  });

  test("validates the complete merged retention policy before persistence or socket effects", async () => {
    const initial = { ...loadSettings(), sessionDownsampleEnabled: true, sessionDownsampleAgeDays: 30 as const, sessionCleanupEnabled: true, sessionCleanupAgeDays: 90 as const };
    saveSettings(initial);
    const restart = spyOn(udpListener, "restart");
    try {
      for (const update of [
        { sessionCleanupAgeDays: 30 },
        { sessionDownsampleAgeDays: 90 },
        { sessionDownsampleAgeDays: 365, sessionCleanupAgeDays: 365 },
        { sessionDownsampleAgeDays: 90, sessionCleanupAgeDays: 30 },
      ]) {
        const before = readFileSync(SETTINGS_PATH, "utf-8");
        const activeHz = getRecordingFrequencyHz();
        const response = await settingsRoutes.request("/api/settings", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...update, udpPort: 5302, recordingFrequencyHz: 50 }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          code: "INVALID_RETENTION_POLICY",
          error: "Automatic deletion must be scheduled after automatic downsampling.",
        });
        expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(before);
        expect(getRecordingFrequencyHz()).toBe(activeHz);
        expect(restart).not.toHaveBeenCalled();
      }
      for (const disabled of ["sessionCleanupEnabled", "sessionDownsampleEnabled"] as const) {
        saveSettings(initial);
        const response = await settingsRoutes.request("/api/settings", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [disabled]: false, sessionCleanupAgeDays: 30 }),
        });
        expect(response.status).toBe(200);
        expect(loadSettings()[disabled]).toBe(false);
        expect(loadSettings().sessionCleanupAgeDays).toBe(30);
        const stored = readFileSync(SETTINGS_PATH, "utf-8");
        const enabling = await settingsRoutes.request("/api/settings", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [disabled]: true }),
        });
        expect(enabling.status).toBe(400);
        expect((await enabling.json()).code).toBe("INVALID_RETENTION_POLICY");
        expect(readFileSync(SETTINGS_PATH, "utf-8")).toBe(stored);
      }
      const response = await settingsRoutes.request("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionDownsampleEnabled: true, sessionDownsampleAgeDays: 30, sessionDownsampleFrequencyHz: 50, sessionCleanupEnabled: true, sessionCleanupAgeDays: 90 }),
      });
      expect(response.status).toBe(200);
      expect(loadSettings().sessionDownsampleEnabled).toBe(true);
      expect(loadSettings().sessionCleanupEnabled).toBe(true);
      expect(() => saveSettings({ ...initial, sessionCleanupAgeDays: 30 })).toThrow("Automatic deletion");
    } finally {
      restart.mockRestore();
    }
  });

  test("loads archival defaults and disables only deletion for externally conflicting policies", () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ driverName: "Preserved", recordingFrequencyHz: 80 }));
    const defaults = loadSettings();
    expect(defaults.sessionDownsampleEnabled).toBe(false);
    expect(defaults.sessionDownsampleAgeDays).toBe(30);
    expect(defaults.sessionDownsampleFrequencyHz).toBe(50);
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      ...defaults, sessionDownsampleEnabled: true, sessionDownsampleAgeDays: 90,
      sessionCleanupEnabled: true, sessionCleanupAgeDays: 30,
    }));
    const loaded = loadSettings();
    expect(loaded.sessionCleanupEnabled).toBe(false);
    expect(loaded.sessionDownsampleEnabled).toBe(true);
    expect(loaded.sessionDownsampleAgeDays).toBe(90);
    expect(loaded.sessionCleanupAgeDays).toBe(30);
    expect(loaded.recordingFrequencyHz).toBe(80);
    expect(loaded.driverName).toBe("Preserved");
  });
});
