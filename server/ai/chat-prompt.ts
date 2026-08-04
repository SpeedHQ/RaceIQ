/**
 * Build the system prompt for the chat agent.
 * Includes the same telemetry context as the analysis prompt,
 * plus the original analysis as reference.
 */
import type { TelemetryPacket, GameId } from "../../shared/types";
import { generateExport, type UnitSystem, type TemperatureUnit } from "../export";
import { buildCornerData } from "./corner-data";
import { analyzeLap } from "../../shared/lib/lap-insights";
import { tryGetServerGame } from "../games/registry";
import { aiLanguageInstruction } from "../../shared/locales";
import { ADJUSTMENT_FORMAT_PROMPT } from "../../shared/prompt-snippets";

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
  },
  packets: TelemetryPacket[],
  corners: CornerDef[],
  unit: UnitSystem = "metric",
  temperatureUnit: TemperatureUnit = unit === "metric" ? "C" : "F",
  /** UI/AI language code (e.g. "en", "de"). Steers prose language. */
  language: string = "en",
): string {
  const gameId: GameId = lap.gameId ?? packets[0]?.gameId;
  const serverAdapter = tryGetServerGame(gameId);

  const exportText = generateExport(lap, packets, unit, temperatureUnit);
  const cornerData = buildCornerData(packets, corners, unit === "metric" ? "kmh" : "mph");

  // Precomputed insights
  const insights = analyzeLap(packets, lap.gameId ?? packets[0]?.gameId);
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



  // Game-specific extended context
  let extendedContext = "";
  if (serverAdapter?.buildAiContext && packets.length > 0) {
    extendedContext = serverAdapter.buildAiContext(packets);
  }

  return `${chatSystemPrompt(unit, temperatureUnit, language)}
${formatLapChatIdentity(lap)}
--- TELEMETRY DATA ---
${exportText}
${cornerData}
${insightsText}${extendedContext}`;
}
