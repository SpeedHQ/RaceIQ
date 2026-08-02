import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { z } from "zod";
import { resolveDataDir } from "./data-dir";
import { isLaunchOnLoginEnabled } from "../platform/launch-on-login";
import { LOCALE_CODES } from "../../../shared/locales";

const SETTINGS_DIR = resolveDataDir();
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

// `""` retained in the enum only for backwards compatibility with previously
// stored settings files where the user hadn't picked a provider yet. Fresh
// installs and defaults resolve to "" (no provider selected) — the user must
// explicitly pick a provider in Settings before any AI feature runs.
const AiProviderSchema = z.enum(["", "gemini", "openai", "local"]).default("");

const AppSettingsSchema = z.object({
  onboardingComplete: z.boolean().default(false),
  driverName: z.string().default(""),
  udpPort: z.number().int().min(1024).max(65535).default(5301),
  unit: z.enum(["metric", "imperial"]).default("metric"),
  temperatureUnit: z.enum(["C", "F"]).default("C"),
  // UI + AI output language (ISO code). Drives Paraglide client locale and the
  // AI "respond in <language>" instruction. Keep in sync with shared/locales.ts
  // and client/project.inlang/settings.json.
  language: z.enum(LOCALE_CODES as [string, ...string[]]).default("en"),
  aiProvider: AiProviderSchema.default(""),
  aiModel: z.string().default(""),
  aiThinkingBudget: z.number().int().min(0).nullable().default(null),
  chatProvider: AiProviderSchema.default(""),
  chatModel: z.string().default(""),
  chatThinkingBudget: z.number().int().min(0).nullable().default(null),
  // Auto-tune analyst provider/model. Independent of the lap-analysis
  // provider (aiProvider) so the user can point auto-tune at a different
  // model. Reuses the same stored API keys as the analysis section.
  autoTuneProvider: AiProviderSchema.default(""),
  autoTuneModel: z.string().default(""),
  // Driver profiling keeps its provider/model independent from other AI
  // features. Background coaching is opt-in and disabled on fresh installs.
  driverProfileBackgroundEnabled: z.boolean().default(false),
  driverProfileProvider: AiProviderSchema.default(""),
  driverProfileModel: z.string().default(""),
  driverProfileThinkingBudget: z.number().int().min(0).nullable().default(null),
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
  launchOnLogin: z.boolean().default(false),
  // Community-tunes CDN sync bookkeeping. Not user-facing; written by the
  // sync job (server/tunes/community-sync.ts) to skip unchanged manifests.
  communityTunesVersion: z.string().nullable().default(null),
  communityTunesSyncedAt: z.string().nullable().default(null),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

const DEFAULTS: AppSettings = AppSettingsSchema.parse({});

function ensureSettingsDir(): void {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
}

/** Returns true if settings file doesn't exist yet (fresh install) */
export function isFirstRun(): boolean {
  return !existsSync(SETTINGS_PATH);
}

export function loadSettings(): AppSettings {
  ensureSettingsDir();
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
    if (parsed.autoTuneProvider === "claude-cli") {
      parsed.autoTuneProvider = "gemini";
    }
    // Seed auto-tune provider/model from the legacy shared analysis provider
    // for settings written before auto-tune had its own entry.
    if (parsed.autoTuneProvider === undefined && parsed.aiProvider !== undefined) {
      parsed.autoTuneProvider = parsed.aiProvider;
    }
    if (parsed.autoTuneModel === undefined && parsed.aiModel !== undefined) {
      parsed.autoTuneModel = parsed.aiModel;
    }
    // Strip legacy color-threshold fields — now owned by game adapters
    delete parsed.tireTempCelsiusThresholds;
    delete parsed.tireTemperatureThresholds;
    delete parsed.tireHealthThresholds;
    delete parsed.suspensionThresholds;

    const result = AppSettingsSchema.parse(parsed);
    // Always sync launchOnLogin from the actual registry state
    result.launchOnLogin = isLaunchOnLoginEnabled();
    return result;
  } catch (err) {
    console.error(`[Settings] Failed to load ${SETTINGS_PATH}:`, err instanceof Error ? err.message : err);
    console.warn(`[Settings] Falling back to defaults`);
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: AppSettings): void {
  ensureSettingsDir();
  // Validate before writing
  const validated = AppSettingsSchema.parse(settings);
  const tmpPath = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2) + "\n");
  renameSync(tmpPath, SETTINGS_PATH);
}

/** Persisted community-tunes sync state (manifest version + last sync time). */
export function getCommunityTunesSyncState(): {
  version: string | null;
  syncedAt: string | null;
} {
  const s = loadSettings();
  return {
    version: s.communityTunesVersion,
    syncedAt: s.communityTunesSyncedAt,
  };
}

/** Persist the manifest version and sync timestamp after a successful sync. */
export function setCommunityTunesSyncState(version: string): void {
  const s = loadSettings();
  s.communityTunesVersion = version;
  s.communityTunesSyncedAt = new Date().toISOString();
  saveSettings(s);
}

/** Schema for partial updates from the API */
export const PartialSettingsSchema = AppSettingsSchema.partial();
export type PartialSettings = z.infer<typeof PartialSettingsSchema>;
