import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

import { loadSettings } from "../server/settings";

const SETTINGS_DIR = "./data";
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
