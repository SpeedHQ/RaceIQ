/**
 * Build the system prompt for the chat agent.
 * Includes the same telemetry context as the analysis prompt,
 * plus the original analysis as reference.
 */
import type { TelemetryPacket, Tune, GameId } from "../../shared/types";
import { generateExport, type UnitSystem } from "../export";
import { getCarName, getTrackName } from "../../shared/car-data";
import { buildCornerData } from "./corner-data";
import { analyzeLap } from "../../client/src/lib/lap-insights";
import { formatTuneForPrompt } from "./format-tune";
import { tryGetServerGame } from "../games/registry";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

function chatSystemPrompt(unit: UnitSystem) {
  const units = unit === "metric" ? "km/h, °C, meters, bar" : "mph, °F, feet, psi";
  return `You are a racing engineer. Answer the driver's questions about their lap using the telemetry data below.

Be brief. Use bullet points. Cite specific numbers in ${units}. Address them as "you". No JSON output.`;
}

export function buildChatSystemPrompt(
  lap: {
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
  tune?: Tune,
  analysisJson?: string,
): string {
  const carName = getCarName(lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0);
  const trackName = getTrackName(lap.trackOrdinal ?? 0);

  const exportText = generateExport(lap, packets, unit);
  const cornerData = buildCornerData(packets, corners, unit === "metric" ? "kmh" : "mph");

  // Precomputed insights
  const insights = analyzeLap(packets);
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
    tuneText = "\n" + formatTuneForPrompt({
      name: tune.name,
      author: tune.author,
      category: tune.category,
      settings: tune.settings,
    }) + "\n";
  }

  let analysisContext = "";
  if (analysisJson) {
    try {
      const parsed = JSON.parse(analysisJson);
      analysisContext = `\n--- PREVIOUS ANALYSIS (already shown to driver) ---\nVerdict: ${parsed.verdict}\n`;
      if (parsed.corners?.length) {
        analysisContext += "Problem corners: " + parsed.corners.map((c: any) => `${c.name} (${c.severity}): ${c.issue}`).join("; ") + "\n";
      }
      if (parsed.technique?.length) {
        analysisContext += "Technique tips: " + parsed.technique.map((t: any) => t.tip).join("; ") + "\n";
      }
      if (parsed.setup?.length) {
        analysisContext += "Setup changes: " + parsed.setup.map((s: any) => `${s.change}: ${s.fix}`).join("; ") + "\n";
      }
    } catch {
      // If analysis JSON is invalid, include raw
      analysisContext = `\n--- PREVIOUS ANALYSIS ---\n${analysisJson}\n`;
    }
  }

  const gameId: GameId = lap.gameId ?? packets[0]?.gameId;

  // Game-specific extended context
  let extendedContext = "";
  const serverAdapter = tryGetServerGame(gameId);
  if (serverAdapter?.buildAiContext && packets.length > 0) {
    extendedContext = serverAdapter.buildAiContext(packets);
  }

  // Game-specific system prompt override (use chat version, not analysis JSON version)
  const gameSystemNote = serverAdapter?.aiSystemPrompt
    ? `\nGame-specific notes: This is ${serverAdapter.aiSystemPrompt.split("\n")[0]}\n`
    : "";

  return `${chatSystemPrompt(unit)}
${gameSystemNote}
--- LAP CONTEXT ---
Car: ${carName}
Track: ${trackName}
Lap #${lap.lapNumber} — ${lap.lapTime.toFixed(3)}s${lap.isValid ? "" : " (INVALID)"}
${tuneText}${analysisContext}
--- TELEMETRY DATA ---
${exportText}
${cornerData}
${insightsText}${extendedContext}`;
}
