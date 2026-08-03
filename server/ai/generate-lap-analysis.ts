import type { Tune, GameId, TelemetryPacket } from "../../shared/types";
import { getLapById, getCorners, getAnalysis, saveAnalysis } from "../db/queries";
import { getTuneById as getDbTune } from "../db/tune-queries";
import { detectCorners, type Corner } from "../corner-detection";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "./analyst-prompt";
import { resolveTrack } from "../track-info";
import { computeLapSectors } from "../compute-lap-sectors";
import { lapAnalystAgent } from "./agents";
import { getAnalystJsonSchema, AnalystOutputSchema } from "./schemas";
import { buildGoogleProviderOptions } from "./google-provider-options";
import { getSecret } from "../keystore";
import { extractJson } from "./extract-json";
import { toClientAiError } from "./provider-error";
import { resolveLapF1Setup } from "./f1-setup-identity";
import { normalizePacketSetup, topCatalogReferences, getCatalogDisplayName } from "./f1-setup-catalog";

export interface AnalysisUsage { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string }
export interface CornerFraction { label: string; startFrac: number; endFrac: number }
export interface LapAnalysisResult { analysis: string | null; cached: boolean; usage?: AnalysisUsage; cornerFracs: CornerFraction[]; hasTune: boolean; error?: string }

type GenerateDeps = { generate?: typeof lapAnalystAgent.generate };
export async function generateLapAnalysis(lapId: number, options: { regenerate?: boolean; cacheOnly?: boolean } = {}, deps: GenerateDeps = {}): Promise<LapAnalysisResult> {
  const lap = await getLapById(lapId);
  if (!lap) return { analysis: null, cached: false, cornerFracs: [], hasTune: false, error: "Lap not found" };
  if (lap.telemetry.length === 0) return { analysis: null, cached: false, cornerFracs: [], hasTune: false, error: "No telemetry data" };
  const trackOrdinal = lap.trackOrdinal ?? 0;
  let corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId) : [];
  if (corners.length === 0) corners = detectCorners(lap.telemetry);
  const totalDist = lap.telemetry.length > 1 ? lap.telemetry[lap.telemetry.length - 1].DistanceTraveled - lap.telemetry[0].DistanceTraveled : 1;
  const firstDist = lap.telemetry[0]?.DistanceTraveled ?? 0;
  const cornerFracs = corners.map((c) => ({ label: c.label, startFrac: Math.max(0, (c.distanceStart - firstDist) / totalDist), endFrac: Math.min(1, (c.distanceEnd - firstDist) / totalDist) }));
  const hasTune = !!lap.tuneId || (lap.gameId === "f1-2025" && !!lap.carSetup);
  if (!options.regenerate) {
    const cached = await getAnalysis(lapId);
    if (cached?.analysis) { try { JSON.parse(cached.analysis); return { analysis: cached.analysis, cached: true, usage: cached, cornerFracs, hasTune }; } catch { /* regenerate malformed cache */ } }
    if (options.cacheOnly) return { analysis: null, cached: false, cornerFracs, hasTune };
  }
  const settings = loadSettings();
  let parsedTune: Tune | undefined;
  if (lap.tuneId) {
    const dbTune = await getDbTune(lap.tuneId);
    if (dbTune) parsedTune = { ...dbTune, strengths: dbTune.strengths ? JSON.parse(dbTune.strengths) : [], weaknesses: dbTune.weaknesses ? JSON.parse(dbTune.weaknesses) : [], bestTracks: dbTune.bestTracks ? JSON.parse(dbTune.bestTracks) : [], strategies: dbTune.strategies ? JSON.parse(dbTune.strategies) : [], settings: JSON.parse(dbTune.settings) } as Tune;
  }
  const track = resolveTrack(lap.gameId, lap.trackOrdinal);
  let sectors: { times: { s1: number; s2: number; s3: number }; s1End: number; s2End: number } | undefined;
  if (track.sectors.s1End && track.sectors.s2End && lap.gameId && lap.trackOrdinal != null) {
    try { const times = await computeLapSectors(lap.trackOrdinal, lap.gameId as GameId, lap.telemetry, lap.lapTime); if (times && times.length >= 3) sectors = { times: { s1: times[0], s2: times[1], s3: times[2] }, s1End: track.sectors.s1End, s2End: track.sectors.s2End }; } catch { /* optional */ }
  }
  let prompt = buildAnalystPrompt(lap, lap.telemetry, corners, settings.unit, settings.temperatureUnit, parsedTune, track.segments, undefined, settings.language, sectors);
  if (lap.gameId === "f1-2025") prompt += buildF1SetupReferenceBlock(lap.carSetup, lap.telemetry, lap.trackOrdinal ?? -1);
  const provider = settings.aiProvider;
  if (!provider) return { analysis: null, cached: false, cornerFracs, hasTune, error: "No AI provider selected. Choose one in Settings → AI Analysis." };
  if (provider === "openai") { const key = await getSecret("openai-api-key"); if (!key) return { analysis: null, cached: false, cornerFracs, hasTune, error: "OpenAI API key not set. Add it in Settings → AI Analysis." }; process.env.OPENAI_API_KEY = key; }
  else if (provider === "local") { process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local"; process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1"; }
  else { const key = await getSecret("gemini-api-key"); if (!key) return { analysis: null, cached: false, cornerFracs, hasTune, error: "Gemini API key not set. Add it in Settings → AI Analysis." }; process.env.GOOGLE_GENERATIVE_AI_API_KEY = key; }
  const model = settings.aiModel || (provider === "openai" ? "gpt-4o-mini" : provider === "local" ? "local-model" : "gemini-flash-latest");
  const startedAt = Date.now();
  try {
    const result = await (deps.generate ?? lapAnalystAgent.generate)(prompt, { maxSteps: 5, ...(provider === "local" ? { activeTools: [] as never[] } : {}), modelSettings: { maxOutputTokens: 8192, temperature: 0 }, providerOptions: { openai: { reasoningEffort: "medium", responseFormat: { type: "json_schema", jsonSchema: { name: "analyst_output", strict: true, schema: getAnalystJsonSchema() } } }, google: buildGoogleProviderOptions(model, getAnalystJsonSchema(), settings.aiThinkingBudget) } } as never);
    const text = extractJson(typeof result.text === "string" ? result.text : "");
    const parsed = AnalystOutputSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { analysis: null, cached: false, cornerFracs, hasTune, error: "Model produced invalid analysis structure. Not cached. Try again or switch model." };
    const raw = (result.usage ?? {}) as Record<string, unknown>; const n = (k: string) => typeof raw[k] === "number" ? raw[k] as number : 0;
    const usage = { inputTokens: n("inputTokens") || n("promptTokens"), outputTokens: n("outputTokens") || n("completionTokens"), costUsd: 0, durationMs: Date.now() - startedAt, model };
    await saveAnalysis(lapId, text, usage);
    return { analysis: text, cached: false, usage, cornerFracs, hasTune };
  } catch (err) { return { analysis: null, cached: false, cornerFracs, hasTune, error: toClientAiError(err).message }; }
}

function buildF1SetupReferenceBlock(carSetupJson: string | undefined, telemetry: TelemetryPacket[], trackOrdinal: number): string {
  const setup = resolveLapF1Setup({ carSetup: carSetupJson, telemetry }); if (!setup || trackOrdinal < 0) return "";
  const current = normalizePacketSetup(setup as unknown as Record<string, unknown>); const refs = topCatalogReferences(trackOrdinal, 5, current); if (!refs.length) return "";
  const lines = [`\n\n--- F1 CURRENT SETUP + TOP-5 REFERENCE SETUPS (${getCatalogDisplayName(trackOrdinal) ?? "this track"}) ---`, "Use this data to populate setup[]. Cite rank/team/author per entry. Only propose steps within the step-cap rules.", "", "Current setup:"];
  for (const [k, v] of Object.entries(current)) lines.push(`  ${k}: ${v}`); for (const r of refs) { lines.push("", `Rank ${r.rank} — ${r.team} / ${r.author} — ${r.lapTime} (${r.weather}, ${r.inputDevice}):`); const deltas = Object.entries(r.delta ?? {}); if (!deltas.length) lines.push("  (identical to current setup)"); else for (const [k, v] of deltas) lines.push(`  ${k}: ${current[k]} → ${(r.setup as Record<string, number>)[k]} (${(v as number) > 0 ? "+" : ""}${v})`); }
  return lines.join("\n");
}
