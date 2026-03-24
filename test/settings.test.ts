import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

import { loadSettings, saveSettings, type AppSettings } from "../server/settings";

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
    expect(settings.tireTempCelsiusThresholds).toEqual({ cold: 65, warm: 105, hot: 138 });
  });

  test("loadSettings migrates legacy speedUnit to unit", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 5300, speedUnit: "mph" }));
    const settings = loadSettings();
    expect(settings.unit).toBe("imperial");
  });

  test("saveSettings persists unit and threshold fields", () => {
    const settings: AppSettings = {
      udpPort: 5300,
      unit: "imperial",
      tireTempCelsiusThresholds: { cold: 60, warm: 100, hot: 130 },
      tireHealthThresholds: { values: [20, 40, 60, 80] },
      suspensionThresholds: { values: [25, 65, 85] },
      activeProfileId: null,
    };
    saveSettings(settings);
    const loaded = loadSettings();
    expect(loaded.unit).toBe("imperial");
    expect(loaded.tireTempCelsiusThresholds).toEqual({ cold: 60, warm: 100, hot: 130 });
  });

  test("loadSettings defaults missing threshold subfields", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 5300, tireTempCelsiusThresholds: { cold: 50 } }));
    const loaded = loadSettings();
    expect(loaded.tireTempCelsiusThresholds.cold).toBe(50);
    expect(loaded.tireTempCelsiusThresholds.warm).toBe(105);
    expect(loaded.tireTempCelsiusThresholds.hot).toBe(138);
  });
});
