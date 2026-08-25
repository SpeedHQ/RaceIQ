import type { Tune } from "../../shared/racing/tuning/types";
import type { GameId } from "../../shared/games/ids";
import { getLapById } from "../db/lap-read-queries";
import { getCorners } from "../db/track-queries";
import { analysisQualityIdentityForLap, getAnalysis, saveAnalysis } from "../db/analysis-queries";
import { getTuneById as getDbTune } from "../db/tune-queries";
import { detectCorners, type Corner } from "../lap-analysis/corners";
import { loadSettings } from "../runtime/config/settings";
import { buildAnalystPrompt, type PromptSectors } from "./analyst-prompt";
import { resolveTrack } from "../tracks/info";
import { computeNativeSectorTimeline, computeLapSectors } from "../lap-analysis/sectors";
import { getGame } from "../../shared/games/registry";
import { lapAnalystAgent } from "./agents";
import { getAnalystJsonSchema, AnalystOutputSchema } from "./schemas";
import { buildGoogleProviderOptions } from "./google-provider-options";
import { extractJson } from "./extract-json";
import { toClientAiError } from "./provider-error";
import { resolveAi } from "./ai-runtime";
import { runAiStructured } from "./model-provider";
import type { StructuredRequest, ResolvedAi } from "./ai-types";
import type { EligibilityDecision } from "../../shared/racing/quality/contracts";
import { isEligibilityUsable, resolveEligibilityDecision } from "../../shared/racing/quality/policies";

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}
export interface CornerFraction {
  label: string;
  startFrac: number;
  endFrac: number;
}
export interface LapAnalysisResult {
  analysis: string | null;
  cached: boolean;
  usage?: AnalysisUsage;
  cornerFracs: CornerFraction[];
  hasTune: boolean;
  error?: string;
}

type AgentGenerate = (prompt: string, options: Record<string, unknown>) => Promise<unknown>;
export interface GenerateLapAnalysisDeps {
  getLapById?: typeof getLapById;
  getCorners?: typeof getCorners;
  getAnalysis?: typeof getAnalysis;
  saveAnalysis?: typeof saveAnalysis;
  getDbTune?: typeof getDbTune;
  detectCorners?: typeof detectCorners;
  computeLapSectors?: typeof computeLapSectors;
  computeNativeSectorTimeline?: typeof computeNativeSectorTimeline;
  getGame?: typeof getGame;
  loadSettings?: typeof loadSettings;
  buildAnalystPrompt?: typeof buildAnalystPrompt;
  resolveTrack?: typeof resolveTrack;
  resolveAi?: typeof resolveAi;
  runAiStructured?: typeof runAiStructured;
  generate?: AgentGenerate;
}

const invalidAnalysisError = "Model produced invalid analysis structure. Not cached. Try again or switch model.";

function blockedEligibilityError(decision: EligibilityDecision): string {
  const reasonCodes = [...new Set(decision.reasons.map(({ code }) => code))];
  return `Lap quality is ${decision.status} for corner-trace analysis${reasonCodes.length > 0 ? `: ${reasonCodes.join(", ")}` : ""}`;
}

function eligibilityPromptContext(decision: EligibilityDecision): string {
  return JSON.stringify(
    {
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      status: decision.status,
      confidence: decision.confidence,
      reasons: decision.reasons.map(({ code, severity, semanticIds, timeRange, distanceRange }) => ({
        code,
        severity,
        semanticIds,
        timeRange,
        distanceRange,
      })),
    },
    null,
    2,
  );
}

function parseAndValidateAnalysis(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const text = extractJson(raw);
    return AnalystOutputSchema.safeParse(JSON.parse(text)).success ? text : null;
  } catch {
    return null;
  }
}

export async function generateLapAnalysis(
  lapId: number,
  options: {
    regenerate?: boolean;
    cacheOnly?: boolean;
    preflight?: boolean;
  } = {},
  deps: GenerateLapAnalysisDeps = {},
): Promise<LapAnalysisResult> {
  const findLap = deps.getLapById ?? getLapById;
  const findCorners = deps.getCorners ?? getCorners;
  const readAnalysis = deps.getAnalysis ?? getAnalysis;
  const writeAnalysis = deps.saveAnalysis ?? saveAnalysis;
  const lap = await findLap(lapId);
  if (!lap)
    return {
      analysis: null,
      cached: false,
      cornerFracs: [],
      hasTune: false,
      error: "Lap not found",
    };
  if (lap.telemetry.length === 0)
    return {
      analysis: null,
      cached: false,
      cornerFracs: [],
      hasTune: false,
      error: "No telemetry data",
    };
  const eligibility = resolveEligibilityDecision(lap, "corner-trace");
  if (!isEligibilityUsable(eligibility)) {
    return {
      analysis: null,
      cached: false,
      cornerFracs: [],
      hasTune: false,
      error: blockedEligibilityError(eligibility),
    };
  }

  const trackOrdinal = lap.trackOrdinal ?? 0;
  let corners: Corner[] = trackOrdinal > 0 && lap.gameId ? await findCorners(trackOrdinal, lap.gameId) : [];
  if (corners.length === 0) corners = (deps.detectCorners ?? detectCorners)(lap.telemetry);
  const totalDist = lap.telemetry.length > 1 ? lap.telemetry[lap.telemetry.length - 1].DistanceTraveled - lap.telemetry[0].DistanceTraveled : 1;
  const firstDist = lap.telemetry[0]?.DistanceTraveled ?? 0;
  const cornerFracs = corners.map((corner) => ({
    label: corner.label,
    startFrac: Math.max(0, (corner.distanceStart - firstDist) / totalDist),
    endFrac: Math.min(1, (corner.distanceEnd - firstDist) / totalDist),
  }));
  const hasTune = !!lap.tuneId || (lap.gameId === "f1-2025" && !!lap.carSetup);

  if (!options.regenerate) {
    const cached = await readAnalysis(lapId);
    const cachedAnalysis = parseAndValidateAnalysis(cached?.analysis);
    if (cached && cachedAnalysis) {
      return {
        analysis: cachedAnalysis,
        cached: true,
        usage: {
          inputTokens: cached.inputTokens,
          outputTokens: cached.outputTokens,
          costUsd: cached.costUsd,
          durationMs: cached.durationMs,
          model: cached.model,
        },
        cornerFracs,
        hasTune,
      };
    }
    if (options.cacheOnly && !options.preflight) return { analysis: null, cached: false, cornerFracs, hasTune };
  }

  const settings = (deps.loadSettings ?? loadSettings)();
  let parsedTune: Tune | undefined;
  if (lap.tuneId) {
    const dbTune = await (deps.getDbTune ?? getDbTune)(lap.tuneId);
    if (dbTune) {
      parsedTune = {
        ...dbTune,
        strengths: dbTune.strengths ? JSON.parse(dbTune.strengths) : [],
        weaknesses: dbTune.weaknesses ? JSON.parse(dbTune.weaknesses) : [],
        bestTracks: dbTune.bestTracks ? JSON.parse(dbTune.bestTracks) : [],
        strategies: dbTune.strategies ? JSON.parse(dbTune.strategies) : [],
        settings: JSON.parse(dbTune.settings),
      } as Tune;
    }
  }
  const track = (deps.resolveTrack ?? resolveTrack)(lap.gameId, lap.trackOrdinal);
  let sectors: PromptSectors | undefined;
  try {
    const game = lap.gameId ? (deps.getGame ?? getGame)(lap.gameId) : undefined;
    if (game?.nativeSectors && game.getNativeSectorLayout) {
      const timeline = (deps.computeNativeSectorTimeline ?? computeNativeSectorTimeline)(lap.telemetry, lap.lapTime, game.getNativeSectorLayout);
      if (timeline && timeline.times.length >= 2) {
        sectors = {
          times: timeline.times,
          sectorStarts: timeline.sectorStarts,
        };
      }
    } else if (track.sectors.s1End && track.sectors.s2End && lap.gameId && lap.trackOrdinal != null) {
      const times = await (deps.computeLapSectors ?? computeLapSectors)(lap.trackOrdinal, lap.gameId as GameId, lap.telemetry, lap.lapTime);
      if (times && times.length >= 3) {
        sectors = {
          times,
          sectorStarts: [0, track.sectors.s1End, track.sectors.s2End],
        };
      }
    }
  } catch {
    // Sector times are optional context.
  }

  const analystPrompt = (deps.buildAnalystPrompt ?? buildAnalystPrompt)(
    lap,
    lap.telemetry,
    corners,
    settings.unit,
    settings.temperatureUnit,
    parsedTune,
    track.segments,
    undefined,
    settings.language,
    sectors,
  );
  const prompt = `${analystPrompt}

Telemetry evidence eligibility:
${eligibilityPromptContext(eligibility)}

Treat every listed limitation as binding. Do not infer unavailable or ineligible evidence.`;

  let ai: ResolvedAi;
  try {
    ai = await (deps.resolveAi ?? resolveAi)("analysis", settings);
  } catch (err) {
    return {
      analysis: null,
      cached: false,
      cornerFracs,
      hasTune,
      error: toClientAiError(err).message,
    };
  }

  if (options.preflight) {
    return { analysis: null, cached: false, cornerFracs, hasTune };
  }
  const model = ai.model;
  const startedAt = Date.now();
  try {
    const schema = getAnalystJsonSchema();
    const input: StructuredRequest<unknown> = {
      prompt,
      schema,
      schemaName: "analyst_output",
      maxOutputTokens: 8192,
      temperature: 0,
    };
    const generationOptions: Record<string, unknown> = {
      maxSteps: 5,
      modelSettings: { maxOutputTokens: 8192, temperature: 0 },
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          responseFormat: {
            type: "json_schema",
            jsonSchema: { name: "analyst_output", strict: true, schema },
          },
        },
        google: buildGoogleProviderOptions(model, schema, settings.aiThinkingBudget),
      },
    };
    const generate = deps.generate ?? ((requestPrompt, requestOptions) => lapAnalystAgent.generate(requestPrompt, requestOptions as never));
    const runStructured = deps.runAiStructured ?? runAiStructured;
    const result = await runStructured(ai, input, (requestContext) => generate(prompt, { ...generationOptions, requestContext }));
    const text = parseAndValidateAnalysis(result.analysis);
    if (!text)
      return {
        analysis: null,
        cached: false,
        cornerFracs,
        hasTune,
        error: invalidAnalysisError,
      };

    const rawUsage = (result.usage ?? {}) as Record<string, unknown>;
    const numberFor = (...keys: string[]) => keys.map((key) => rawUsage[key]).find((value): value is number => typeof value === "number") ?? 0;
    const usage: AnalysisUsage = {
      inputTokens: numberFor("inputTokens", "promptTokens"),
      outputTokens: numberFor("outputTokens", "completionTokens"),
      costUsd: numberFor("costUsd"),
      durationMs: numberFor("durationMs") || Date.now() - startedAt,
      model,
    };
    await writeAnalysis(lapId, text, usage, analysisQualityIdentityForLap(lap));
    return { analysis: text, cached: false, usage, cornerFracs, hasTune };
  } catch (err) {
    return {
      analysis: null,
      cached: false,
      cornerFracs,
      hasTune,
      error: toClientAiError(err).message,
    };
  }
}
