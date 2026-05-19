import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { resolveDataDir } from "./data-dir";

const SETTINGS_DIR = resolveDataDir();
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

// `""` retained in the enum only for backwards compatibility with previously
// stored settings files where the user hadn't picked a provider yet. Fresh
// installs and defaults resolve to "gemini" + "gemini-flash-latest" so the
// whole AI stack points at a real model without extra setup.
const AiProviderSchema = z.enum(["", "gemini", "openai", "local"]).default("gemini");
const ChatProviderSchema = z.enum(["", "gemini", "openai", "local"]).default("gemini");

const AppSettingsSchema = z.object({
  onboardingComplete: z.boolean().default(false),
  driverName: z.string().default(""),
  udpPort: z.number().int().min(1024).max(65535).default(5301),
  unit: z.enum(["metric", "imperial"]).default("metric"),
  temperatureUnit: z.enum(["C", "F"]).default("C"),
  aiProvider: AiProviderSchema.default("gemini"),
  aiModel: z.string().default("gemini-flash-latest"),
  aiThinkingBudget: z.number().int().min(0).nullable().default(null),
  chatProvider: ChatProviderSchema.default("gemini"),
  chatModel: z.string().default("gemini-flash-latest"),
  chatThinkingBudget: z.number().int().min(0).nullable().default(null),
  localEndpoint: z.string().default("http://localhost:1234/v1"),
  wsRefreshRate: z.enum(["60", "50", "40", "30"]).default("60"),
  // Max render rate for the 3D wireframe Canvas. Throttles gl.render
  // calls to cap GPU/CPU work when the scene is idle or when the user
  // wants to trade smoothness for battery/thermal headroom. 15–120 fps.
  renderFpsCap: z.number().int().min(15).max(120).default(60),
  // Max in-memory cache for parsed lap telemetry, in megabytes. Bounds the
  // size of the per-lap TelemetryPacket[] cache used by analyse/compare/chat
  // workflows. LRU eviction kicks in once the budget is exceeded.
  cacheMaxMB: z.number().int().min(16).max(2048).default(256),
  hiddenGames: z.array(z.string()).default([]),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

const DEFAULTS: AppSettings = AppSettingsSchema.parse({});

/** Returns true if settings file doesn't exist yet (fresh install) */
export function isFirstRun(): boolean {
  return !existsSync(SETTINGS_PATH);
}

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

    // Migrate legacy speedUnit/temperatureUnit → unit + temperatureUnit
    if (!parsed.unit && parsed.speedUnit) {
      parsed.unit = parsed.speedUnit === "mph" ? "imperial" : "metric";
    }
    if (parsed.temperatureUnit !== "C" && parsed.temperatureUnit !== "F") {
      parsed.temperatureUnit = parsed.unit === "imperial" ? "F" : "C";
    }
    // Migrate legacy claude-cli provider → gemini
    if (parsed.aiProvider === "claude-cli") {
      parsed.aiProvider = "gemini";
    }
    // Strip legacy color-threshold fields — now owned by game adapters
    delete parsed.tireTempCelsiusThresholds;
    delete parsed.tireTemperatureThresholds;
    delete parsed.tireHealthThresholds;
    delete parsed.suspensionThresholds;

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
