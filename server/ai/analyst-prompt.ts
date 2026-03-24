import type { TelemetryPacket, Tune } from "../../shared/types";
import { generateExport, type UnitSystem } from "../export";
import { getCarName, getTrackName } from "../../shared/car-data";
import { buildCornerData } from "./corner-data";
import { analyzeLap } from "../../client/src/lib/lap-insights";
import { formatTuneForPrompt } from "./format-tune";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

const SYSTEM_PROMPT = `You are an expert Forza Motorsport racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST be valid JSON matching this exact schema. Output ONLY the JSON object, no markdown fences, no extra text.

{
  "verdict": "2-3 sentences assessing overall lap quality, pace, and where the biggest time gains are.",
  "pace": [
    { "label": "short metric name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "handling": [
    { "label": "short metric name", "value": "specific number/stat", "assessment": "good|warning|critical", "detail": "1 sentence explanation" }
  ],
  "corners": [
    { "name": "corner/zone name", "issue": "what's wrong in 1 sentence", "fix": "specific actionable fix in 1-2 sentences", "severity": "minor|moderate|major" }
  ],
  "technique": [
    { "tip": "short imperative title", "detail": "1-2 sentence explanation referencing specific data" }
  ],
  "setup": [
    { "change": "short imperative title", "symptom": "what the data shows", "fix": "specific tuning change with values" }
  ],
  "tuning": [
    { "component": "e.g. Front Springs", "current": "what the data suggests (e.g. Too stiff — 0.00m travel)", "direction": "increase|decrease|adjust", "target": "specific value or range to aim for", "reason": "1 sentence why" }
  ]
}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage. Each with a concrete value.
- "handling": 4-6 items covering suspension travel, tire temps, tire wear balance, oversteer/understeer, weight transfer. Each with a concrete value.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "technique": 3-5 actionable driving tips. Reference specific telemetry values.
- "setup": 3-5 high-level tuning changes. Always include the symptom from data and the specific fix.
- "tuning": 4-8 specific component adjustments with concrete target values. Cover: springs, dampers, anti-roll bars, aero, alignment, differential, tire pressure, gearing, brake bias. Only include components where the data suggests a change is needed.

RULES:
- Reference specific numbers from the data — don't be vague
- Be specific and actionable, not generic
- Address the driver as "you"
- When tune settings are provided, correlate telemetry symptoms (e.g., understeer, tire temps, suspension bottoming) with specific setup values and recommend concrete adjustments with target numbers
- Reference the actual tune values when suggesting changes (e.g., "Front springs at 750 lb/in are too stiff for this track — try 650-680 lb/in")
- Output ONLY valid JSON, nothing else`;

export function buildAnalystPrompt(
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[],
  corners: CornerDef[],
  unit: UnitSystem = "metric",
  tune?: Tune
): string {
  const carName = getCarName(lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0);
  const trackName = getTrackName(lap.trackOrdinal ?? 0);

  const exportText = generateExport(lap, packets, unit);
  const cornerData = buildCornerData(packets, corners, unit === "metric" ? "kmh" : "mph");

  // Run precomputed insight analysis
  const insights = analyzeLap(packets);
  let insightsText = "";
  if (insights.length > 0) {
    insightsText = "\n--- Precomputed Insights (unverified — validate against raw data) ---\n";
    insightsText += "These are automated detections that may contain false positives. Use them as hints, not facts.\n\n";
    for (const insight of insights) {
      // Convert frame index to approximate lap timestamp
      const frameIdx = insight.frameIndices[0];
      const pkt = packets[frameIdx];
      const timestamp = pkt ? `${(pkt.DistanceTraveled).toFixed(0)}m` : "?";
      const count = insight.frameIndices.length;
      insightsText += `[${insight.severity.toUpperCase()}] ${insight.category}: ${insight.label}`;
      insightsText += ` (at ${timestamp}${count > 1 ? `, ${count} occurrences` : ""})\n`;
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

  const context = `Car: ${carName}
Track: ${trackName}
${tuneText}
${exportText}
${cornerData}
${insightsText}`;

  return `${SYSTEM_PROMPT}

--- TELEMETRY DATA ---

${context}`;
}
