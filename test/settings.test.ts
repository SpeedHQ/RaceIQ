import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

import { loadSettings, saveSettings, type AppSettings } from "../server/settings";

const SETTINGS_DIR = "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

describe("settings with temperature fields", () => {
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
    expect(settings.temperatureUnit).toBe("F");
    expect(settings.tireTemperatureThresholds).toEqual({ cold: 150, warm: 220, hot: 280 });
  });

  test("saveSettings persists temperature fields", () => {
    const settings: AppSettings = {
      udpPort: 5300,
      temperatureUnit: "C",
      tireTemperatureThresholds: { cold: 140, warm: 210, hot: 270 },
    };
    saveSettings(settings);
    const loaded = loadSettings();
    expect(loaded.temperatureUnit).toBe("C");
    expect(loaded.tireTemperatureThresholds).toEqual({ cold: 140, warm: 210, hot: 270 });
  });

  test("loadSettings defaults missing threshold subfields", () => {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 5300, tireTemperatureThresholds: { cold: 100 } }));
    const loaded = loadSettings();
    expect(loaded.tireTemperatureThresholds.cold).toBe(100);
    expect(loaded.tireTemperatureThresholds.warm).toBe(220);
    expect(loaded.tireTemperatureThresholds.hot).toBe(280);
  });
});
