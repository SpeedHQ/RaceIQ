import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const SETTINGS_DIR = process.env.DATA_DIR ?? "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

export interface ColorThresholds {
  /** Sorted ascending — values between thresholds map to colors */
  values: number[];
}

export interface AppSettings {
  udpPort: number;
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: {
    cold: number;
    warm: number;
    hot: number;
  };
  /** Tire health % thresholds (ascending). Below first = red, between = orange/yellow/lime, above last = green */
  tireHealthThresholds: ColorThresholds;
  /** Suspension travel thresholds (ascending, 0-1). Below first = blue, between = green, above = yellow/red */
  suspensionThresholds: ColorThresholds;
  activeProfileId: number | null;
}

const DEFAULTS: AppSettings = {
  udpPort: 5300,
  temperatureUnit: "F",
  speedUnit: "mph",
  tireTemperatureThresholds: {
    cold: 150,
    warm: 220,
    hot: 280,
  },
  tireHealthThresholds: { values: [20, 40, 60, 80] },
  suspensionThresholds: { values: [25, 65, 85] },
  activeProfileId: null,
};

export function loadSettings(): AppSettings {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  if (!existsSync(SETTINGS_PATH)) {
    saveSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      udpPort: parsed.udpPort ?? DEFAULTS.udpPort,
      temperatureUnit: parsed.temperatureUnit ?? DEFAULTS.temperatureUnit,
      speedUnit: parsed.speedUnit ?? DEFAULTS.speedUnit,
      tireTemperatureThresholds: {
        cold: parsed.tireTemperatureThresholds?.cold ?? DEFAULTS.tireTemperatureThresholds.cold,
        warm: parsed.tireTemperatureThresholds?.warm ?? DEFAULTS.tireTemperatureThresholds.warm,
        hot: parsed.tireTemperatureThresholds?.hot ?? DEFAULTS.tireTemperatureThresholds.hot,
      },
      tireHealthThresholds: {
        values: Array.isArray(parsed.tireHealthThresholds?.values)
          ? parsed.tireHealthThresholds.values
          : DEFAULTS.tireHealthThresholds.values,
      },
      suspensionThresholds: {
        values: Array.isArray(parsed.suspensionThresholds?.values)
          ? parsed.suspensionThresholds.values
          : DEFAULTS.suspensionThresholds.values,
      },
      activeProfileId: parsed.activeProfileId ?? DEFAULTS.activeProfileId,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: AppSettings): void {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}
