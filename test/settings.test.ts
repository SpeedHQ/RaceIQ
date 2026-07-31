import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadSettings } from "../server/settings";
import { settingsRoutes } from "../server/routes/settings-routes";

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
});

describe("Codex provider discovery", () => {
  const originalCodexPath = process.env.CODEX_CLI_PATH;

  afterEach(() => {
    if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCodexPath;
  });

  test("reports Codex unavailable without exposing secrets when executable is missing", async () => {
    process.env.CODEX_CLI_PATH = join(tmpdir(), `raceiq-missing-codex-${crypto.randomUUID()}`);
    const response = await settingsRoutes.request("/api/ai-providers");
    expect(response.status).toBe(200);
    const providers = await response.json() as Array<{ id: string; ready?: boolean; error?: string | null }>;
    expect(providers.find((provider) => provider.id === "codex")).toMatchObject({
      id: "codex",
      ready: false,
    });
    expect(providers.find((provider) => provider.id === "codex")?.error).toContain("not found");
  });

  test("reports Codex ready when login status succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raceiq-codex-ready-"));
    const executable = join(dir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    process.env.CODEX_CLI_PATH = executable;

    const response = await settingsRoutes.request("/api/ai-providers");
    const providers = await response.json() as Array<{ id: string; ready?: boolean; error?: string | null }>;
    expect(providers.find((provider) => provider.id === "codex")).toMatchObject({
      id: "codex",
      ready: true,
      error: null,
    });
  });

  test("keeps Codex model discovery empty", async () => {
    const response = await settingsRoutes.request("/api/ai-models?providers=codex");
    expect(response.status).toBe(200);
    const models = await response.json() as { codex: unknown[] };
    expect(models.codex).toEqual([]);
  });
});
