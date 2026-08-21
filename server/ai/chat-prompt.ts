/**
 * Build the system prompt for the chat agent.
 * Includes the same telemetry context as the analysis prompt,
 * plus the original analysis as reference.
 */
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { buildQualityPromptContext } from "./quality-context";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { Tune } from "../../shared/racing/tuning/types";
import type { GameId } from "../../shared/games/ids";
import { generateExport, type UnitSystem, type TemperatureUnit } from "../lap-analysis/report";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { buildCornerData } from "./corner-data";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import { formatTuneForPrompt } from "./format-tune";
import { tryGetServerGame } from "../games/registry";
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
  packets: TelemetryPacket[],
  corners: CornerDef[],
  unit: UnitSystem = "metric",
  temperatureUnit: TemperatureUnit = unit === "metric" ? "C" : "F",
  tune?: Tune,
  analysisJson?: string,
  /** UI/AI language code (e.g. "en", "de"). Steers prose language. */
  language: string = "en",
): string {
  const gameId: GameId = lap.gameId ?? packets[0]?.gameId;
  const serverAdapter = tryGetServerGame(gameId);
  const carOrdinal = lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0;
  const trackOrdinal = lap.trackOrdinal ?? packets[0]?.TrackOrdinal ?? 0;
  const gameName = serverAdapter?.displayName ?? gameId ?? "unknown game";
  const carName = resolveCarName(carOrdinal, gameId);
  const trackName = resolveTrackName(trackOrdinal, gameId);

  const exportText = generateExport(lap, packets, unit, temperatureUnit);
  const cornerData = buildCornerData(packets, corners, unit === "metric" ? "kmh" : "mph");

  // Precomputed insights
  const insights = analyzeLap(packets, lap.gameId ?? packets[0]?.gameId, lap.quality);
  let insightsText = "";
  if (insights.length > 0) {
    insightsText = "\n--- Precomputed Insights ---\n";
    for (const insight of insights) {
      const frameIdx = insight.frameIndices[0];
      const pkt = packets[frameIdx];
      const timestamp = pkt ? `${pkt.DistanceTraveled.toFixed(0)}m` : "?";
      insightsText += `[${insight.severity.toUpperCase()}] ${insight.category}: ${insight.label} (at ${timestamp})\n`;
      insightsText += `  ${insight.detail}\n`;
    }
  }

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
      const parsed = JSON.parse(analysisJson);
      analysisContext = `\n--- PREVIOUS ANALYSIS (already shown to driver) ---\nVerdict: ${parsed.verdict}\n`;
      if (parsed.corners?.length) {
        analysisContext += `Problem corners: ${parsed.corners.map((c: any) => `${c.name} (${c.severity}): ${c.issue}`).join("; ")}\n`;
      }
      if (parsed.technique?.length) {
        analysisContext += `Technique tips: ${parsed.technique.map((t: any) => t.tip).join("; ")}\n`;
      }
      if (parsed.setup?.length) {
        analysisContext += `Setup changes: ${parsed.setup.map((s: any) => `${s.change}: ${s.fix}`).join("; ")}\n`;
      }
    } catch {
      // If analysis JSON is invalid, include raw
      analysisContext = `\n--- PREVIOUS ANALYSIS ---\n${analysisJson}\n`;
    }
  }

  // Game-specific extended context
  let extendedContext = "";
  if (serverAdapter?.buildAiContext && packets.length > 0) {
    extendedContext = serverAdapter.buildAiContext(packets);
  }

  // Game-specific system prompt override (use chat version, not analysis JSON version)
  const gameSystemNote = serverAdapter?.aiSystemPrompt ? `\nGame-specific notes: This is ${serverAdapter.aiSystemPrompt.split("\n")[0]}\n` : "";
  const qualityContext = buildQualityPromptContext(lap, ["corner-trace", "transient-event", "fuel-burn", "tire-analysis"]);

  return `${chatSystemPrompt(unit, temperatureUnit, language)}
${gameSystemNote}
--- SESSION IDENTITY ---
Game: ${gameName}
Game ID: ${gameId ?? "unknown"}
Car: ${carName}
Car ID: ${carOrdinal}
Track: ${trackName}
Track ID: ${trackOrdinal}
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
${insightsText}${extendedContext}`;
}
