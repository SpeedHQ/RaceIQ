import type { TelemetryPacket, Tune, GameId } from "../../shared/types";
import { generateExport, type UnitSystem } from "../export";
import { getCarName, getTrackName, carSpecsMap } from "../../shared/car-data";
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

const FORZA_SYSTEM_PROMPT = `You are an expert Forza Motorsport racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

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
    { "name": "corner/zone name", "issue": "what's wrong in 1 sentence", "fix": "specific actionable fix", "severity": "minor|moderate|major" }
  ],
  "braking": [
    { "corner": "corner name matching corner data labels", "assessment": "good|warning|critical", "brakePoint": "e.g. 85m before apex", "detail": "1 sentence with numbers" }
  ],
  "throttle": [
    { "corner": "corner name matching corner data labels", "assessment": "good|warning|critical", "throttlePoint": "e.g. 40% at apex, full at exit", "detail": "1 sentence with numbers" }
  ],
  "coaching": [
    { "tip": "short imperative title", "detail": "1-2 sentence explanation referencing specific data" }
  ],
  "setup": [
    { "component": "e.g. Front Springs", "symptom": "what the telemetry shows", "fix": "what to change and why", "current": "numeric value with unit (e.g. 750 lb/in)", "target": "numeric target value with unit (e.g. 650 lb/in)", "direction": "increase|decrease|adjust" }
  ]
}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage.
- "handling": 4-6 items covering suspension travel, tire temps, tire wear balance, oversteer/understeer, weight transfer.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "braking": Per-corner braking analysis for every corner in the corner data. Use corner label names exactly. "good" = no issues. If detail describes a problem, MUST be "warning" or "critical".
- "throttle": Per-corner throttle analysis for every corner. Use corner label names exactly. "good" = clean application. If detail describes a problem, MUST be "warning" or "critical".
- "coaching": 3-5 actionable driving tips. Reference specific telemetry values.
- "setup": 4-8 component adjustments. Each item has the symptom (what telemetry shows), fix (what to do), AND concrete "current"/"target" numeric values with units (e.g. "750 lb/in" → "650 lb/in"). Cover: springs, dampers, anti-roll bars, aero, alignment, differential, tire pressure, gearing, brake bias as needed. If tune data is provided, reference actual tune values.

RULES:
- Reference specific numbers from the data — don't be vague
- Use the driver's preferred units: {{UNITS}}
- Be specific and actionable, not generic
- Address the driver as "you"
- When tune settings are provided, correlate telemetry symptoms (e.g., understeer, tire temps, suspension bottoming) with specific setup values and recommend concrete adjustments with target numbers
- Reference the actual tune values when suggesting changes (e.g., "Front springs at 750 lb/in are too stiff for this track — try 650-680 lb/in")
- Output ONLY valid JSON, nothing else
- Escape any special characters in string values (quotes, newlines)
- Do not include trailing commas in arrays or objects`;

function getSystemPrompt(gameId: GameId, unit: UnitSystem): string {
  const units = unit === "metric" ? "km/h, °C, meters, kg, bar" : "mph, °F, feet, lb, psi";
  const adapter = tryGetServerGame(gameId);
  const base = adapter ? adapter.aiSystemPrompt : FORZA_SYSTEM_PROMPT;
  return base.replace("{{UNITS}}", units);
}

export function buildAnalystPrompt(
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
  segments?: { type: string; name: string; startFrac: number; endFrac: number }[],
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

  let segmentsList = "";
  if (segments && segments.length > 0) {
    segmentsList = "\n--- Track Segments (use these EXACT names in braking/throttle/corners) ---\n";
    segmentsList += segments.map((s) => `${s.type === "corner" ? "🔶" : "🔷"} ${s.name} (${(s.startFrac * 100).toFixed(1)}%-${(s.endFrac * 100).toFixed(1)}%)`).join("\n");
    segmentsList += "\n";
  }

  // Get car specs for additional context
  const carOrdinal = lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0;
  const specs = carSpecsMap.get(carOrdinal);
  let carDetailsText = `Car: ${carName}`;
  if (specs) {
    carDetailsText += `\nClass: ${specs.division}`;
    carDetailsText += `\nPerformance Index (PI): ${specs.pi}`;
    carDetailsText += `\nDimensions: ${specs.weightKg}kg, ${specs.hp}hp, ${specs.drivetrain}`;
  }

  const context = `${carDetailsText}
Track: ${trackName}
${tuneText}${segmentsList}
${exportText}
${cornerData}
${insightsText}`;

  const gameId: GameId = lap.gameId ?? packets[0]?.gameId;
  const systemPrompt = getSystemPrompt(gameId, unit);

  // Build game-specific extended context via adapter
  let f1ExtendedContext = "";
  const serverAdapter = tryGetServerGame(gameId);
  if (serverAdapter?.buildAiContext && packets.length > 0) {
    f1ExtendedContext = serverAdapter.buildAiContext(packets);
  }

  return `${systemPrompt}

--- TELEMETRY DATA ---

${context}${f1ExtendedContext}`;
}
