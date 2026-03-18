import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const SETTINGS_DIR = "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

export interface AppSettings {
  udpPort: number;
}

const DEFAULTS: AppSettings = {
  udpPort: 5300,
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
