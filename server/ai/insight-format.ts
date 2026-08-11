import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";

/**
 * Format one lap's precomputed insights as a prompt block for the compare
 * flows. Mirrors the analyst prompt's insight section: severity, category,
 * label, approximate lap distance, and detail per line.
 */
export function buildCompareInsightsBlock(label: string, packets: TelemetryPacket[], gameId: GameId | undefined): string {
  if (!gameId || packets.length === 0) return "";
  const insights = analyzeLap(packets, gameId);
  if (insights.length === 0) return "";
  let out = `\n--- ${label} Precomputed Insights (unverified — automated detections, may contain false positives; use as hints) ---\n`;
  for (const insight of insights) {
    const pkt = packets[insight.frameIndices[0]];
    const at = pkt ? `${pkt.DistanceTraveled.toFixed(0)}m` : "?";
    out += `[${insight.severity.toUpperCase()}] ${insight.category}: ${insight.label} (at ${at}) — ${insight.detail}\n`;
  }
  return out;
}
