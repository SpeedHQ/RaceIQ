import type { FindingRecord } from "../../shared/racing/findings/types";

/**
 * Build the system prompt for the chat agent.
 * Includes the same telemetry context as the analysis prompt,
 * plus the original analysis as reference.
 */
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { buildQualityPromptContext } from "./quality-context";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { Tune } from "../../shared/racing/tuning/types";
import type { GameId } from "../../shared/games/ids";
import { generateExport, type UnitSystem, type TemperatureUnit } from "../lap-analysis/report";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { buildCornerData } from "./corner-data";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import { assessSemanticAnalysisInput } from "./insight-format";
import { adaptLapInsightsToFindingBundle } from "../findings/lap-adapter";
import { buildFindingsContext } from "./findings-context";
import { AnalystOutputSchema } from "./schemas";
import { formatTuneForPrompt } from "./format-tune";
import { getGame } from "../../shared/games/registry";
import { aiLanguageInstruction } from "../../shared/integrations/ai/language";
import { ADJUSTMENT_FORMAT_PROMPT } from "../../shared/integrations/ai/prompt-snippets";
interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

function chatSystemPrompt(unit: UnitSystem, temperatureUnit: TemperatureUnit, language: string) {
  const baseUnits = unit === "metric" ? "km/h, meters, bar" : "mph, feet, psi";
  const units = `${baseUnits}, °${temperatureUnit}`;
  return `You are a racing engineer. Answer the driver's questions about their lap using the telemetry data below.

Be brief. Use bullet points. Cite specific numbers in ${units}. Address them as "you". Temperature unit for this session is °${temperatureUnit}. No JSON output.${ADJUSTMENT_FORMAT_PROMPT}${aiLanguageInstruction(language)}`;
}

export function formatLapChatIdentity(lap: { id?: number; lapNumber: number; lapTime: number }): string {
  return `Lap ID: ${lap.id ?? "unknown"}\nLap #${lap.lapNumber} — ${lap.lapTime.toFixed(3)}s`;
}

export function buildChatSystemPrompt(
  lap: {
    id?: number;
    sessionId?: string | number;
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
    gameId?: GameId;
    quality?: LapQualitySummary | null;
    eligibility?: EligibilityDecisionSet | null;
    qualityGeneration?: string | null;
  },
  samples: readonly SemanticTelemetrySample[],
  corners: CornerDef[],
  unit: UnitSystem = "metric",
  temperatureUnit: TemperatureUnit = unit === "metric" ? "C" : "F",
  tune?: Tune,
  analysisJson?: string,
  /** UI/AI language code (e.g. "en", "de"). Steers prose language. */
  language: string = "en",
  /** Persisted deterministic records for this lap's current generation. */
  storedFindings?: readonly FindingRecord[],
): string {
  if (!lap.gameId) throw new Error("Lap gameId is required for chat prompt");
  const gameId: GameId = lap.gameId;
  const gameName = getGame(gameId).displayName;
  const carName = lap.carOrdinal == null ? "Unavailable" : resolveCarName(lap.carOrdinal, gameId);
  const trackName = lap.trackOrdinal == null ? "Unavailable" : resolveTrackName(lap.trackOrdinal, gameId);
  const carId = lap.carOrdinal == null ? "unavailable" : String(lap.carOrdinal);
  const trackId = lap.trackOrdinal == null ? "unavailable" : String(lap.trackOrdinal);

  const exportText = generateExport(lap, samples, unit, temperatureUnit);
  const cornerData = buildCornerData(samples, corners, unit === "metric" ? "kmh" : "mph");

  const insights = analyzeLap(samples, gameId, lap.quality);
  const semanticQuality = assessSemanticAnalysisInput(samples, gameId, lap.lapTime);
  const persistedQualityValid = lap.quality?.complete === true && lap.quality.structurallyValid;
  const quality = {
    valid: persistedQualityValid && semanticQuality.valid,
    reason: semanticQuality.reason ?? lap.quality?.invalidReason ?? (lap.quality ? "recording incomplete" : "quality evidence unavailable"),
  };
  const insightBundle =
    lap.id !== undefined && lap.sessionId !== undefined && lap.gameId !== undefined
      ? adaptLapInsightsToFindingBundle({
          gameId: lap.gameId,
          sessionId: lap.sessionId,
          lapId: lap.id,
          insights,
          quality,
        })
      : undefined;
  const findingsContext = storedFindings
    ? buildFindingsContext(storedFindings)
    : insightBundle
      ? buildFindingsContext(insightBundle.findings, {
          narratives: insightBundle.narratives,
          recommendations: insightBundle.recommendations,
        })
      : "";
  const qualityAbstention = quality.valid ? "" : `[ABSTENTION] Lap recording quality rejected: ${quality.reason ?? "unknown reason"}; do not make lap-performance claims from this telemetry.`;
  const findingsText = [qualityAbstention, findingsContext].filter(Boolean).join("\n");

  let tuneText = "";
  if (tune) {
    tuneText =
      "\n" +
      formatTuneForPrompt({
        name: tune.name,
        author: tune.author,
        category: tune.category,
        settings: tune.settings,
      }) +
      "\n";
  }

  let analysisContext = "";
  if (analysisJson) {
    try {
      const parsed = AnalystOutputSchema.safeParse(JSON.parse(analysisJson));
      if (parsed.success) {
        analysisContext = `\n--- PREVIOUS ANALYSIS (already shown to driver; narrative only, not finding evidence) ---\nVerdict: ${parsed.data.verdict}\n`;
        if (parsed.data.corners.length) {
          analysisContext += `Problem corners: ${parsed.data.corners.map((corner) => `${corner.name} (${corner.severity}): ${corner.issue}`).join("; ")}\n`;
        }
        if (parsed.data.technique.length) {
          analysisContext += `Technique tips: ${parsed.data.technique.map((tip) => tip.tip).join("; ")}\n`;
        }
        if (parsed.data.setup?.length) {
          analysisContext += `Setup changes: ${parsed.data.setup.map((item) => `${item.component}: ${item.fix}`).join("; ")}\n`;
        }
      }
    } catch {
      // Malformed cached prose is not structured context and cannot be evidence.
    }
  }

  const extendedContext = "";

  const qualityContext = buildQualityPromptContext(lap, ["corner-trace", "transient-event", "fuel-burn", "tire-analysis"]);

  return `${chatSystemPrompt(unit, temperatureUnit, language)}
--- SESSION IDENTITY ---
Game: ${gameName}
Game ID: ${gameId}
Car: ${carName}
Car ID: ${carId}
Track: ${trackName}
Track ID: ${trackId}
${formatLapChatIdentity(lap)}
--- LAP CONTEXT ---
Car: ${carName}
Track: ${trackName}
Lap #${lap.lapNumber} — ${lap.lapTime.toFixed(3)}s${lap.isValid ? "" : " (INVALID)"}
${qualityContext}
${tuneText}${analysisContext}
--- TELEMETRY DATA ---
${exportText}
${cornerData}
${findingsText ? `\n${findingsText}\n` : ""}${extendedContext}`;
}
