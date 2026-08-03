import type { Tune, GameId, TelemetryPacket } from "../../shared/types";
import {
  getLapById,
  getCorners,
  getAnalysis,
  saveAnalysis,
} from "../db/queries";
import { getTuneById as getDbTune } from "../db/tune-queries";
import { detectCorners, type Corner } from "../corner-detection";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "./analyst-prompt";
import { resolveTrack } from "../track-info";
import { computeLapSectors } from "../compute-lap-sectors";
import { lapAnalystAgent } from "./agents";
import { getAnalystJsonSchema, AnalystOutputSchema } from "./schemas";
import { buildGoogleProviderOptions } from "./google-provider-options";
import { extractJson } from "./extract-json";
import { toClientAiError } from "./provider-error";
import { resolveAi } from "./ai-runtime";
import { runAiStructured } from "./model-provider";
import type { StructuredRequest, ResolvedAi } from "./ai-types";
import { resolveLapF1Setup } from "./f1-setup-identity";
import {
  normalizePacketSetup,
  topCatalogReferences,
  getCatalogDisplayName,
} from "./f1-setup-catalog";

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

type AgentGenerate = (
  prompt: string,
  options: Record<string, unknown>,
) => Promise<unknown>;
export interface GenerateLapAnalysisDeps {
  getLapById?: typeof getLapById;
  getCorners?: typeof getCorners;
  getAnalysis?: typeof getAnalysis;
  saveAnalysis?: typeof saveAnalysis;
  getDbTune?: typeof getDbTune;
  detectCorners?: typeof detectCorners;
  loadSettings?: typeof loadSettings;
  buildAnalystPrompt?: typeof buildAnalystPrompt;
  resolveTrack?: typeof resolveTrack;
  computeLapSectors?: typeof computeLapSectors;
  resolveAi?: typeof resolveAi;
  runAiStructured?: typeof runAiStructured;
  generate?: AgentGenerate;
}

const invalidAnalysisError =
  "Model produced invalid analysis structure. Not cached. Try again or switch model.";

function parseAndValidateAnalysis(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const text = extractJson(raw);
    return AnalystOutputSchema.safeParse(JSON.parse(text)).success
      ? text
      : null;
  } catch {
    return null;
  }
}

export async function generateLapAnalysis(
  lapId: number,
  options: { regenerate?: boolean; cacheOnly?: boolean } = {},
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

  const trackOrdinal = lap.trackOrdinal ?? 0;
  let corners: Corner[] =
    trackOrdinal > 0 && lap.gameId
      ? await findCorners(trackOrdinal, lap.gameId)
      : [];
  if (corners.length === 0)
    corners = (deps.detectCorners ?? detectCorners)(lap.telemetry);
  const totalDist =
    lap.telemetry.length > 1
      ? lap.telemetry[lap.telemetry.length - 1].DistanceTraveled -
        lap.telemetry[0].DistanceTraveled
      : 1;
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
    if (options.cacheOnly)
      return { analysis: null, cached: false, cornerFracs, hasTune };
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

  const track = (deps.resolveTrack ?? resolveTrack)(
    lap.gameId,
    lap.trackOrdinal,
  );
  let sectors:
    | {
        times: { s1: number; s2: number; s3: number };
        s1End: number;
        s2End: number;
      }
    | undefined;
  if (
    track.sectors.s1End &&
    track.sectors.s2End &&
    lap.gameId &&
    lap.trackOrdinal != null
  ) {
    try {
      const times = await (deps.computeLapSectors ?? computeLapSectors)(
        lap.trackOrdinal,
        lap.gameId as GameId,
        lap.telemetry,
        lap.lapTime,
      );
      if (times && times.length >= 3) {
        sectors = {
          times: { s1: times[0], s2: times[1], s3: times[2] },
          s1End: track.sectors.s1End,
          s2End: track.sectors.s2End,
        };
      }
    } catch {
      // Sector times are optional context.
    }
  }

  let prompt = (deps.buildAnalystPrompt ?? buildAnalystPrompt)(
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
  if (lap.gameId === "f1-2025")
    prompt += buildF1SetupReferenceBlock(
      lap.carSetup,
      lap.telemetry,
      lap.trackOrdinal ?? -1,
    );

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
        google: buildGoogleProviderOptions(
          model,
          schema,
          settings.aiThinkingBudget,
        ),
      },
    };
    const generate =
      deps.generate ??
      ((requestPrompt, requestOptions) =>
        lapAnalystAgent.generate(requestPrompt, requestOptions as never));
    const runStructured = deps.runAiStructured ?? runAiStructured;
    const result = await runStructured(ai, input, (requestContext) =>
      generate(prompt, { ...generationOptions, requestContext }),
    );
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
    const numberFor = (...keys: string[]) =>
      keys
        .map((key) => rawUsage[key])
        .find((value): value is number => typeof value === "number") ?? 0;
    const usage: AnalysisUsage = {
      inputTokens: numberFor("inputTokens", "promptTokens"),
      outputTokens: numberFor("outputTokens", "completionTokens"),
      costUsd: numberFor("costUsd"),
      durationMs: numberFor("durationMs") || Date.now() - startedAt,
      model,
    };
    await writeAnalysis(lapId, text, usage);
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

function buildF1SetupReferenceBlock(
  carSetupJson: string | undefined,
  telemetry: TelemetryPacket[],
  trackOrdinal: number,
): string {
  const setup = resolveLapF1Setup({ carSetup: carSetupJson, telemetry });
  if (!setup || trackOrdinal < 0) return "";
  const current = normalizePacketSetup(
    setup as unknown as Record<string, unknown>,
  );
  const refs = topCatalogReferences(trackOrdinal, 5, current);
  if (!refs.length) return "";
  const lines = [
    `\n\n--- F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS (${getCatalogDisplayName(trackOrdinal) ?? "this track"}) ---`,
    "Use this data to populate setup[]. Cite rank/team/author per entry. Only propose steps within the step-cap rules.",
    "",
    "Current setup:",
  ];
  for (const [key, value] of Object.entries(current))
    lines.push(`  ${key}: ${value}`);
  for (const reference of refs) {
    lines.push(
      "",
      `Rank ${reference.rank} — ${reference.team} / ${reference.author} — ${reference.lapTime} (${reference.weather}, ${reference.inputDevice}):`,
    );
    const deltas = Object.entries(reference.delta ?? {});
    if (!deltas.length) lines.push("  (identical to current setup)");
    else
      for (const [key, value] of deltas)
        lines.push(
          `  ${key}: ${current[key]} → ${(reference.setup as Record<string, number>)[key]} (${(value as number) > 0 ? "+" : ""}${value})`,
        );
  }
  return lines.join("\n");
}
