import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { z } from "zod";

const SETTINGS_DIR = process.env.DATA_DIR ?? "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

const ColorThresholdsSchema = z.object({
  values: z.array(z.number()),
});

const AppSettingsSchema = z.object({
  udpPort: z.number().int().min(1024).max(65535).default(5300),
  unit: z.enum(["metric", "imperial"]).default("metric"),
  tireTempCelsiusThresholds: z.object({
    cold: z.number().default(65),
    warm: z.number().default(105),
    hot: z.number().default(138),
  }).default({ cold: 65, warm: 105, hot: 138 }),
  tireHealthThresholds: ColorThresholdsSchema.default({ values: [20, 40, 60, 80] }),
  suspensionThresholds: ColorThresholdsSchema.default({ values: [25, 65, 85] }),
  activeProfileId: z.number().int().nullable().default(null),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type ColorThresholds = z.infer<typeof ColorThresholdsSchema>;

const DEFAULTS: AppSettings = AppSettingsSchema.parse({});

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

    // Migrate legacy speedUnit/temperatureUnit → unit
    if (!parsed.unit && parsed.speedUnit) {
      parsed.unit = parsed.speedUnit === "mph" ? "imperial" : "metric";
    }
    // Migrate legacy tireTemperatureThresholds → tireTempCelsiusThresholds
    if (!parsed.tireTempCelsiusThresholds && parsed.tireTemperatureThresholds) {
      parsed.tireTempCelsiusThresholds = parsed.tireTemperatureThresholds;
    }

    return AppSettingsSchema.parse(parsed);
  } catch (err) {
    console.error(`[Settings] Failed to load ${SETTINGS_PATH}:`, err instanceof Error ? err.message : err);
    console.warn(`[Settings] Falling back to defaults`);
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: AppSettings): void {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  // Validate before writing
  const validated = AppSettingsSchema.parse(settings);
  writeFileSync(SETTINGS_PATH, JSON.stringify(validated, null, 2) + "\n");
}

/** Schema for partial updates from the API */
export const PartialSettingsSchema = AppSettingsSchema.partial();
export type PartialSettings = z.infer<typeof PartialSettingsSchema>;
