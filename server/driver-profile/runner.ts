import { createHash } from "node:crypto";

import type { GameId } from "../../shared/games/ids";
import { tryGetGame } from "../../shared/games/registry";
import type { LapMeta } from "../../shared/racing/sessions/types";
import { loadSettings } from "../runtime/config/settings";
import { getSecret } from "../runtime/platform/keystore";
import { toClientAiError, type ClientAiError } from "../ai/provider-error";
import { driverProfilerAgent } from "../ai/agents";
import { buildDriverProfilerPrompt } from "./prompt";
import { getDriverProfileSummaryJsonSchema, parseDriverProfileSummary, type DriverProfileSummary } from "../ai/schemas";
import { buildGoogleProviderOptions } from "../ai/google-provider-options";
import type { DriverFingerprint } from "./fingerprint";
import { loadDriverProfile } from "./load";
import {
  createDriverProfileRun,
  findDriverProfileRunByScopePool,
  getDriverProfileRun,
  listDriverProfileRuns,
  saveDriverProfile,
  updateDriverProfileRun,
  type DriverProfileRunRow,
  type DriverProfileRunStatus,
  type DriverProfileScopeKey,
} from "../db/driver-profile-queries";
import { getLapMetaForProfileScope } from "../db/lap-read-queries";
import type { AnalysisUsage } from "../db/analysis-queries";

export type DriverProfileScope = Pick<DriverProfileScopeKey, "gameId">;
export type DriverProfileState = DriverProfileRunStatus | "disabled" | "not-configured";

export interface DriverProfileRunResult {
  status: DriverProfileState;
  run: DriverProfileRunRow | null;
  summary?: DriverProfileSummary;
  fingerprint?: DriverFingerprint;
  usage?: AnalysisUsage;
  error?: string;
}

export interface DriverProfileRunOptions {
  /** Explicit/manual runs may regenerate a successful pool. */
  force?: boolean;
  trigger?: "manual" | "background" | "retry";
}

const BACKGROUND_LAP_BATCH = 5;
export const DRIVER_PROFILE_DEFAULT_OUTPUT_TOKENS = 5_000;
export const DRIVER_PROFILE_MAX_OUTPUT_TOKENS = 32_768;

export function driverProfilePoolKey(laps: readonly Pick<LapMeta, "id" | "qualityGeneration" | "qualityStale">[]): string {
  const evidence = laps
    .slice(0, 60)
    .sort((left, right) => left.id - right.id)
    .map((lap) => [lap.id, lap.qualityGeneration ?? null, lap.qualityStale ?? null]);
  return createHash("sha1")
    .update(`driver-trend-summary-v2|${JSON.stringify(evidence)}`)
    .digest("hex")
    .slice(0, 16);
}

function scopeKey(scope: DriverProfileScope): string {
  return `${scope.gameId}|*|*`;
}
const pendingLaps = new Map<string, { count: number; poolKey: string }>();
const activeRuns = new Map<string, Promise<DriverProfileRunResult>>();
export function resolveDriverProfileScopeNames(scope: DriverProfileScope): { gameName: string } {
  const game = tryGetGame(scope.gameId);
  return { gameName: game?.displayName ?? scope.gameId };
}

function now(): string {
  return new Date().toISOString();
}

function normalizedError(err: unknown): { message: string; details: ClientAiError | null } {
  const details = toClientAiError(err);
  return { message: details.message || "Driver profile generation failed", details };
}
export function logDriverProfileFailure(runId: number, model: string, error: string): void {
  console.error(`[AI] Driver profile run ${runId} failed (model=${model}): ${error}`);
}
export function logDriverProfileOutput(runId: number, model: string, result: { text?: unknown; object?: unknown; reasoning?: unknown; finishReason?: unknown; usage?: unknown }): void {
  let output = typeof result.text === "string" ? result.text : "";
  if (!output && typeof result.reasoning === "string") output = `[reasoning-only] ${result.reasoning}`;
  if (result.object !== undefined) {
    try {
      output = JSON.stringify(result.object) ?? "<empty>";
    } catch {
      output = "[unserializable object]";
    }
  }
  const finishReason = typeof result.finishReason === "string" ? result.finishReason : "<unknown>";
  const usage = result.usage === undefined ? "<none>" : JSON.stringify(result.usage);
  console.error(`[AI] Driver profile run ${runId} raw output (model=${model}, finishReason=${finishReason}, usage=${usage}, resultKeys=${Object.keys(result).join(",")}): ${output || "<empty>"}`);
}
async function failDriverProfileRun(scope: DriverProfileScope, runId: number, fingerprint: DriverFingerprint, error: string, durationMs: number): Promise<DriverProfileRunResult> {
  await updateDriverProfileRun(runId, scopeKey(scope), "running", {
    status: "failed",
    error,
    fingerprint: JSON.stringify(fingerprint),
    durationMs,
    completedAt: now(),
  });
  return { status: "failed", run: await getDriverProfileRun(runId), fingerprint, error };
}

async function providerConfiguration(): Promise<{ ok: true; provider: "gemini" | "openai" | "local"; model: string; thinkingBudget: number | null } | { ok: false; reason: string }> {
  const settings = loadSettings();
  const provider = settings.driverProfileProvider;
  if (!provider) return { ok: false, reason: "No driver-profile AI provider is configured." };

  if (provider === "openai") {
    const key = await getSecret("openai-api-key");
    if (!key) return { ok: false, reason: "OpenAI API key is not configured for driver profiling." };
    process.env.OPENAI_API_KEY = key;
  } else if (provider === "local") {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
    process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
  } else {
    const key = await getSecret("gemini-api-key");
    if (!key) return { ok: false, reason: "Gemini API key is not configured for driver profiling." };
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
  }

  return {
    ok: true,
    provider,
    model: settings.driverProfileModel || (provider === "openai" ? "gpt-4o-mini" : provider === "local" ? "local-model" : "gemini-flash-latest"),
    thinkingBudget: settings.driverProfileThinkingBudget,
  };
}
export async function getDriverProfileConfiguration(): Promise<{
  enabled: boolean;
  configured: boolean;
  reason?: string;
}> {
  const settings = loadSettings();
  const config = await providerConfiguration();
  return config.ok ? { enabled: settings.driverProfileBackgroundEnabled, configured: true } : { enabled: settings.driverProfileBackgroundEnabled, configured: false, reason: config.reason };
}

async function runDriverProfileInternal(scope: DriverProfileScope, options: DriverProfileRunOptions): Promise<DriverProfileRunResult> {
  const config = await providerConfiguration();
  if (!config.ok) return { status: "not-configured", run: null, error: config.reason };

  const candidates = await getLapMetaForProfileScope(scope.gameId);
  const poolKey = driverProfilePoolKey(candidates);
  const existing = await findDriverProfileRunByScopePool(scope, poolKey);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    if (!options.force) return { status: existing.status, run: existing };
    await updateDriverProfileRun(existing.id, scopeKey(scope), existing.status, {
      status: "failed",
      error: "Superseded by an explicit profile run.",
      completedAt: now(),
    });
  }
  if (existing?.status === "succeeded" && !options.force) {
    return { status: "succeeded", run: existing };
  }

  const runId = await createDriverProfileRun(scope, { poolKey, model: config.model, status: "queued" });
  await updateDriverProfileRun(runId, scopeKey(scope), "queued", { status: "running", startedAt: now() });

  const startedAt = Date.now();
  let fingerprint: DriverFingerprint | null = null;
  try {
    fingerprint = await loadDriverProfile({ gameId: scope.gameId });
    if (!fingerprint.ok) {
      return await failDriverProfileRun(scope, runId, fingerprint, "Not enough valid laps to build a driver profile.", Date.now() - startedAt);
    }

    const prompt = buildDriverProfilerPrompt({
      fingerprint,
      language: loadSettings().language,
    });
    const result = await driverProfilerAgent.generate(prompt, {
      modelSettings: { maxOutputTokens: loadSettings().driverProfileMaxOutputTokens, temperature: 0 },
      providerOptions: {
        openai: {
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name: "driver_profile_summary",
              strict: true,
              schema: getDriverProfileSummaryJsonSchema() as Record<string, never>,
            },
          },
        } as never,
        google: buildGoogleProviderOptions(config.model, getDriverProfileSummaryJsonSchema() as Record<string, unknown>, config.thinkingBudget) as never,
      },
    });

    const parsed = parseDriverProfileSummary(typeof result.text === "string" ? result.text : "");
    if (!parsed.success) {
      logDriverProfileOutput(runId, config.model, result);
      logDriverProfileFailure(runId, config.model, "Model produced output that did not match the expected driver profile summary shape.");
      return await failDriverProfileRun(scope, runId, fingerprint, "Model produced output that did not match the expected driver profile summary shape.", Date.now() - startedAt);
    }

    const summary = parsed.data;
    const rawUsage = (result.usage ?? {}) as Record<string, unknown>;
    const number = (key: string): number => (typeof rawUsage[key] === "number" ? (rawUsage[key] as number) : 0);
    const usage: AnalysisUsage = {
      inputTokens: number("inputTokens") || number("promptTokens"),
      outputTokens: number("outputTokens") || number("completionTokens"),
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      model: config.model,
    };

    // A background generation can finish after more laps arrive. Never let it
    // replace a cache or successful run produced for the newer pool.
    const latestCandidates = await getLapMetaForProfileScope(scope.gameId);
    if (driverProfilePoolKey(latestCandidates) !== poolKey) {
      return await failDriverProfileRun(scope, runId, fingerprint, "Profile data changed while generation was running; stale result discarded.", usage.durationMs);
    }
    const history = await listDriverProfileRuns(scope, 100);
    if (history.some((item) => item.id > runId && item.status === "succeeded")) {
      return await failDriverProfileRun(scope, runId, fingerprint, "A newer successful profile run already exists; stale result discarded.", usage.durationMs);
    }

    await saveDriverProfile(scope, {
      poolKey,
      fingerprint: JSON.stringify(fingerprint),
      plan: JSON.stringify(summary),
      usage,
    });
    await updateDriverProfileRun(runId, scopeKey(scope), "running", {
      status: "succeeded",
      fingerprint: JSON.stringify(fingerprint),
      plan: JSON.stringify(summary),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      durationMs: usage.durationMs,
      model: usage.model,
      completedAt: now(),
    });
    return {
      status: "succeeded",
      run: await getDriverProfileRun(runId),
      summary,
      fingerprint,
      usage,
    };
  } catch (err) {
    const normalized = normalizedError(err);
    await updateDriverProfileRun(runId, scopeKey(scope), "running", {
      status: "failed",
      error: JSON.stringify(normalized.details ?? { message: normalized.message }),
      fingerprint: fingerprint ? JSON.stringify(fingerprint) : null,
      durationMs: Date.now() - startedAt,
      completedAt: now(),
    });
    return { status: "failed", run: await getDriverProfileRun(runId), fingerprint: fingerprint ?? undefined, error: normalized.message };
  }
}

export function runDriverProfile(scope: DriverProfileScope, options: DriverProfileRunOptions = {}): Promise<DriverProfileRunResult> {
  const key = scopeKey(scope);
  const active = activeRuns.get(key);
  if (active) return active;
  const promise = runDriverProfileInternal(scope, options).finally(() => {
    activeRuns.delete(key);
  });
  activeRuns.set(key, promise);
  return promise;
}

function scheduleScope(scope: DriverProfileScope, poolKey: string): void {
  const key = scopeKey(scope);
  const pending = pendingLaps.get(key);
  pendingLaps.set(key, { count: (pending?.count ?? 0) + 1, poolKey });
  const next = pendingLaps.get(key);
  if (!next || next.count < BACKGROUND_LAP_BATCH) return;
  pendingLaps.delete(key);
  void runDriverProfile(scope, { trigger: "background" }).catch((err) => {
    console.error("[AI] Background driver profile run failed:", err);
  });
}

/**
 * Non-blocking notification boundary called after any lap is persisted.
 * It intentionally does no work when background profiling is disabled.
 */
export function notifyDriverProfileLap(gameId: GameId): void {
  const settings = loadSettings();
  if (!settings.driverProfileBackgroundEnabled) return;
  void getLapMetaForProfileScope(gameId)
    .then((globalLaps) => {
      scheduleScope({ gameId }, driverProfilePoolKey(globalLaps));
    })
    .catch((err) => {
      console.error("[AI] Failed to schedule background driver profile:", err);
    });
}

export async function getDriverProfileRunStatus(
  scope: DriverProfileScope,
  limit = 50,
): Promise<{
  state: DriverProfileState;
  enabled: boolean;
  configured: boolean;
  reason?: string;
  latest: DriverProfileRunRow | null;
  runs: DriverProfileRunRow[];
}> {
  const runs = await listDriverProfileRuns(scope, limit);
  const config = await getDriverProfileConfiguration();
  const latest = runs[0] ?? null;
  return {
    enabled: config.enabled,
    configured: config.configured,
    state: !config.configured ? "not-configured" : (latest?.status ?? (!config.enabled ? "disabled" : "succeeded")),
    reason: config.reason,
    latest,
    runs,
  };
}

export function resetDriverProfileRunnerForTests(): void {
  pendingLaps.clear();
  activeRuns.clear();
}
