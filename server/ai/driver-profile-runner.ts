import { createHash } from "crypto";

import type { GameId } from "../../shared/types";
import { tryGetGame } from "../../shared/games/registry";
import { loadSettings } from "../settings";
import { getSecret } from "../keystore";
import { toClientAiError, type ClientAiError } from "./provider-error";
import { driverProfilerAgent } from "./agents";
import { buildDriverProfilerPrompt } from "./driver-profiler-prompt";
import { getDriverProfileJsonSchema, parseDriverProfileOutput, type DriverProfileOutput } from "./schemas";
import { buildGoogleProviderOptions } from "./google-provider-options";
import { loadDriverProfile, type DriverFingerprint } from "./driver-profile-aggregate";
import {
  createDriverProfileRun,
  findDriverProfileRunByScopePool,
  getDriverProfile,
  getDriverProfileRun,
  getLapMetaForProfileScope,
  listDriverProfileRuns,
  saveDriverProfile,
  updateDriverProfileRun,
  type AnalysisUsage,
  type DriverProfileRunRow,
  type DriverProfileRunStatus,
  type DriverProfileScopeKey,
} from "../db/queries";

export type DriverProfileScope = DriverProfileScopeKey;
export type DriverProfileState = DriverProfileRunStatus | "disabled" | "not-configured";

export interface DriverProfileRunResult {
  status: DriverProfileState;
  run: DriverProfileRunRow | null;
  plan?: DriverProfileOutput;
  fingerprint?: DriverFingerprint;
  usage?: AnalysisUsage;
  warnings?: string[];
  error?: string;
}

export interface DriverProfileRunOptions {
  /** Explicit/manual runs may regenerate a successful pool. */
  force?: boolean;
  trigger?: "manual" | "background" | "retry";
}

const BACKGROUND_LAP_BATCH = 5;
const pendingLaps = new Map<string, { count: number; poolKey: string }>();
const activeRuns = new Map<string, Promise<DriverProfileRunResult>>();

export function driverProfilePoolKey(lapIds: number[]): string {
  return createHash("sha1")
    .update(lapIds.slice().sort((a, b) => a - b).join(","))
    .digest("hex")
    .slice(0, 16);
}

function scopeKey(scope: DriverProfileScope): string {
  return `${scope.gameId}|${scope.carOrdinal ?? "*"}|${scope.trackOrdinal ?? "*"}`;
}

export function resolveDriverProfileScopeNames(scope: DriverProfileScope): { gameName: string; carName?: string; trackName?: string } {
  const game = tryGetGame(scope.gameId);
  if (!game) return { gameName: scope.gameId };
  return {
    gameName: game.displayName,
    carName: scope.carOrdinal != null ? game.getCarName(scope.carOrdinal) : undefined,
    trackName: scope.trackOrdinal != null ? game.getTrackName(scope.trackOrdinal) : undefined,
  };
}

function pruneUnknownFocusAreas(plan: DriverProfileOutput, fingerprint: DriverFingerprint): string[] {
  const known = new Set(fingerprint.detectors.map((detector) => detector.id));
  const dropped: string[] = [];
  plan.focusAreas = plan.focusAreas.filter((focus) => {
    if (known.has(focus.detectorId)) return true;
    dropped.push(focus.detectorId);
    return false;
  });
  return dropped;
}

function now(): string {
  return new Date().toISOString();
}

function normalizedError(err: unknown): { message: string; details: ClientAiError | null } {
  const details = toClientAiError(err);
  return { message: details.message || "Driver profile generation failed", details };
}

async function providerConfiguration(): Promise<
  | { ok: true; provider: "gemini" | "openai" | "local"; model: string; thinkingBudget: number | null }
  | { ok: false; reason: string }
> {
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
    model:
      settings.driverProfileModel ||
      (provider === "openai" ? "gpt-4o-mini" : provider === "local" ? "local-model" : "gemini-flash-latest"),
    thinkingBudget: settings.driverProfileThinkingBudget,
  };
}

export async function getDriverProfileConfiguration(): Promise<{
  enabled: boolean;
  configured: boolean;
  reason?: string;
}> {
  const settings = loadSettings();
  if (!settings.driverProfileBackgroundEnabled) return { enabled: false, configured: false, reason: "Background profiling is disabled." };
  const config = await providerConfiguration();
  return config.ok
    ? { enabled: true, configured: true }
    : { enabled: true, configured: false, reason: config.reason };
}

async function runDriverProfileInternal(
  scope: DriverProfileScope,
  options: DriverProfileRunOptions,
): Promise<DriverProfileRunResult> {
  const config = await providerConfiguration();
  if (!config.ok) return { status: "not-configured", run: null, error: config.reason };

  const candidates = await getLapMetaForProfileScope(scope.gameId, scope.carOrdinal ?? undefined, scope.trackOrdinal ?? undefined);
  const poolKey = driverProfilePoolKey(candidates.map((lap) => lap.id));
  const existing = await findDriverProfileRunByScopePool(scope, poolKey);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    return { status: existing.status, run: existing };
  }
  if (existing?.status === "succeeded" && !options.force) {
    return { status: "succeeded", run: existing };
  }

  const runId = await createDriverProfileRun(scope, { poolKey, model: config.model, status: "queued" });
  await updateDriverProfileRun(runId, scopeKey(scope), "queued", { status: "running", startedAt: now() });

  const startedAt = Date.now();
  let fingerprint: DriverFingerprint | null = null;
  try {
    fingerprint = await loadDriverProfile({
      gameId: scope.gameId,
      carOrdinal: scope.carOrdinal ?? undefined,
      trackOrdinal: scope.trackOrdinal ?? undefined,
    });
    if (!fingerprint.ok) {
      const error = "Not enough valid laps to build a driver profile.";
      await updateDriverProfileRun(runId, scopeKey(scope), "running", {
        status: "failed",
        error,
        fingerprint: JSON.stringify(fingerprint),
        durationMs: Date.now() - startedAt,
        completedAt: now(),
      });
      return { status: "failed", run: await getDriverProfileRun(runId), fingerprint, error };
    }

    const prompt = buildDriverProfilerPrompt({
      fingerprint,
      ...resolveDriverProfileScopeNames(scope),
      language: loadSettings().language,
    });
    const result = await driverProfilerAgent.generate(prompt, {
      modelSettings: { maxOutputTokens: 6144, temperature: 0 },
      providerOptions: {
        openai: {
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name: "driver_profile_output",
              strict: true,
              schema: getDriverProfileJsonSchema() as Record<string, never>,
            },
          },
        } as never,
        google: buildGoogleProviderOptions(
          config.model,
          getDriverProfileJsonSchema() as Record<string, unknown>,
          config.thinkingBudget,
        ) as never,
      },
    });

    const parsed = parseDriverProfileOutput(typeof result.text === "string" ? result.text : "");
    if (!parsed.success) {
      const error = "Model produced output that did not match the expected driver profile shape.";
      await updateDriverProfileRun(runId, scopeKey(scope), "running", {
        status: "failed",
        error,
        fingerprint: JSON.stringify(fingerprint),
        durationMs: Date.now() - startedAt,
        completedAt: now(),
      });
      return { status: "failed", run: await getDriverProfileRun(runId), fingerprint, error };
    }

    const plan = parsed.data;
    const dropped = pruneUnknownFocusAreas(plan, fingerprint);
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
    const latestCandidates = await getLapMetaForProfileScope(scope.gameId, scope.carOrdinal ?? undefined, scope.trackOrdinal ?? undefined);
    if (driverProfilePoolKey(latestCandidates.map((lap) => lap.id)) !== poolKey) {
      const error = "Profile data changed while generation was running; stale result discarded.";
      await updateDriverProfileRun(runId, scopeKey(scope), "running", { status: "failed", error, fingerprint: JSON.stringify(fingerprint), durationMs: usage.durationMs, completedAt: now() });
      return { status: "failed", run: await getDriverProfileRun(runId), fingerprint, error };
    }
    const priorCache = await getDriverProfile(scope);
    const history = await listDriverProfileRuns(scope, 100);
    if (history.some((item) => item.id > runId && item.status === "succeeded")) {
      const error = "A newer successful profile run already exists; stale result discarded.";
      await updateDriverProfileRun(runId, scopeKey(scope), "running", { status: "failed", error, fingerprint: JSON.stringify(fingerprint), durationMs: usage.durationMs, completedAt: now() });
      return { status: "failed", run: await getDriverProfileRun(runId), fingerprint, error };
    }
    if (priorCache?.poolKey === poolKey && history.some((item) => item.id > runId && item.status === "succeeded")) {
      const error = "A newer successful profile cache already exists; stale result discarded.";
      await updateDriverProfileRun(runId, scopeKey(scope), "running", { status: "failed", error, fingerprint: JSON.stringify(fingerprint), durationMs: usage.durationMs, completedAt: now() });
      return { status: "failed", run: await getDriverProfileRun(runId), fingerprint, error };
    }

    await saveDriverProfile(scope, {
      poolKey,
      fingerprint: JSON.stringify(fingerprint),
      plan: JSON.stringify(plan),
      usage,
    });
    await updateDriverProfileRun(runId, scopeKey(scope), "running", {
      status: "succeeded",
      fingerprint: JSON.stringify(fingerprint),
      plan: JSON.stringify(plan),
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
      plan,
      fingerprint,
      usage,
      ...(dropped.length > 0 ? { warnings: [`Ignored ${dropped.length} focus area(s) citing faults not in the profile.`] } : {}),
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

export function runDriverProfile(
  scope: DriverProfileScope,
  options: DriverProfileRunOptions = {},
): Promise<DriverProfileRunResult> {
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
 * Non-blocking notification boundary called after a valid lap is persisted.
 * It intentionally does no work when background profiling is disabled.
 */
export function notifyDriverProfileLap(gameId: GameId, carOrdinal: number, trackOrdinal: number): void {
  const settings = loadSettings();
  if (!settings.driverProfileBackgroundEnabled) return;
  void Promise.all([
    getLapMetaForProfileScope(gameId),
    getLapMetaForProfileScope(gameId, carOrdinal, trackOrdinal),
  ]).then(([globalLaps, exactLaps]) => {
    scheduleScope({ gameId }, driverProfilePoolKey(globalLaps.map((lap) => lap.id)));
    scheduleScope({ gameId, carOrdinal, trackOrdinal }, driverProfilePoolKey(exactLaps.map((lap) => lap.id)));
  }).catch((err) => {
    console.error("[AI] Failed to schedule background driver profile:", err);
  });
}

export async function getDriverProfileRunStatus(scope: DriverProfileScope, limit = 50): Promise<{
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
    state: !config.enabled ? "disabled" : !config.configured ? "not-configured" : latest?.status ?? "succeeded",
    enabled: config.enabled,
    configured: config.configured,
    reason: config.reason,
    latest,
    runs,
  };
}

export function resetDriverProfileRunnerForTests(): void {
  pendingLaps.clear();
  activeRuns.clear();
}
