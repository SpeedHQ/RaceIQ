import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
/**
 * Format one lap's precomputed insights as a prompt block for the compare
 * flows. Mirrors the analyst prompt's insight section: severity, category,
 * label, approximate lap distance, and detail per line.
 */
export function buildCompareInsightsBlock(label: string, packets: TelemetryPacket[], insights: LapInsight[]): string {
  if (packets.length === 0 || insights.length === 0) return "";
  let out = `\n--- ${label} Precomputed Insights (unverified — automated detections, may contain false positives; use as hints) ---\n`;
  for (const insight of insights) {
    const pkt = packets[insight.frameIndices[0]];
    const at = pkt ? `${pkt.DistanceTraveled.toFixed(0)}m` : "?";
    out += `[${insight.severity.toUpperCase()}] ${insight.category}: ${insight.label} (at ${at}) — ${insight.detail}\n`;
  }
  return out;
}
