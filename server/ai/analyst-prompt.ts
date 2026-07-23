import type { TelemetryPacket, Tune, GameId } from "../../shared/types";
import { generateExport, type UnitSystem, type TemperatureUnit } from "../export";
import { getCarName, getTrackName, carSpecsMap } from "../../shared/car-data";
import { buildCornerData } from "./corner-data";
import { analyzeLap } from "../../shared/lib/lap-insights";
import { formatTuneForPrompt } from "./format-tune";
import { tryGetServerGame } from "../games/registry";
import { buildTrackGuideContext, guideCornerLabels } from "./track-guides";
import { telemetryToTrackConditions, formatTrackConditions } from "./track-conditions";
import { segmentDisplayName, segmentDisplayNames } from "../../shared/segment-label";
import { aiLanguageInstruction } from "../../shared/locales";
import { ADJUSTMENT_FORMAT_PROMPT } from "../../shared/prompt-snippets";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

/**
 * A curated track segment (#84) as the prompt consumes it. `numbers` are the
 * official turn numbers the section covers — they're what makes "Eau
 * Rouge/Raidillon (2-4)" rather than a bare name, so pass them through.
 */
export interface PromptSegment {
  type: string;
  name: string;
  startFrac: number;
  endFrac: number;
  numbers?: number[];
}

/** A lap's sector times, seconds. */
export interface PromptSectors {
  s1: number;
  s2: number;
  s3: number;
}

/**
 * Combine corner labels from the DB-stored `trackCorners` rows and the
 * shared-track-meta `segments` entries into a deduped whitelist. Used to
 * constrain the model's corner naming so it can't invent labels like
 * "Bit-Kurve" at a track that doesn't have one.
 */
function collectCornerLabels(corners: CornerDef[], segments?: PromptSegment[], guideLabels?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (label?: string) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    out.push(label);
  };
  for (const c of corners) push(c.label);
  if (segments) {
    // segmentDisplayName, not s.name: the track map and the expert guide both
    // label this corner "Eau Rouge/Raidillon (2-4)". Whitelisting the bare name
    // would leave the model told to use a label that isn't on the list.
    for (const s of segments) {
      if (s.type === "corner") push(segmentDisplayName(s, 0));
    }
  }
  if (guideLabels) for (const l of guideLabels) push(l);
  return out;
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
- "setup": 4-8 component adjustments. Each item has the symptom (what telemetry shows), fix (what to do), AND concrete "current"/"target" numeric values with units (e.g. "750 lb/in" → "650 lb/in"). Cover: springs, dampers (Bump first, then Rebound), anti-roll bars, aero, alignment, differential, tire pressure, gearing, brake bias as needed. If tune data is provided, reference actual tune values.

RULES:
- Reference specific numbers from the data — don't be vague
- Use the driver's preferred units: {{UNITS}}
- Be specific and actionable, not generic
- Address the driver as "you"
- When tune settings are provided, correlate telemetry symptoms (e.g., understeer, tire temps, suspension bottoming) with specific setup values and recommend concrete adjustments with target numbers
- Reference the actual tune values when suggesting changes (e.g., "Front springs at 750 lb/in are too stiff for this track — try 650-680 lb/in")
- For Forza-style tune recommendations, adjustable tune values are front/rear axle settings only. Never recommend individual FL/FR/RL/RR tire pressure, damping, spring, anti-roll bar, ride-height, aero, or alignment changes. If per-tire telemetry differs, translate it into a front/rear axle adjustment or a driving/coaching note.
- Output ONLY valid JSON, nothing else
- Escape any special characters in string values (quotes, newlines)
- Do not include trailing commas in arrays or objects`;

function getSystemPrompt(gameId: GameId, unit: UnitSystem, temperatureUnit: TemperatureUnit, language: string): string {
  const speedDistanceWeight = unit === "metric" ? "km/h, meters, kg, bar" : "mph, feet, lb, psi";
  const units = `${speedDistanceWeight}, °${temperatureUnit}`;
  const adapter = tryGetServerGame(gameId);
  const base = adapter ? adapter.aiSystemPrompt : FORZA_SYSTEM_PROMPT;
  return `${base.replace("{{UNITS}}", units)}\n- Temperature unit in this session: °${temperatureUnit}${ADJUSTMENT_FORMAT_PROMPT}${aiLanguageInstruction(language, { json: true })}`;
}

export function buildAnalystPrompt(
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
  tune?: Tune,
  segments?: PromptSegment[],
  /** Pre-fetched track guide text. When provided, skips internal lookup. */
  externalTrackGuide?: string,
  /** UI/AI language code (e.g. "en", "de"). Steers prose language. */
  language: string = "en",
  /** This lap's sector times, with the boundaries they were split on. */
  sectors?: { times: PromptSectors; s1End: number; s2End: number },
): string {
  const carName = getCarName(lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0);
  const trackName = getTrackName(lap.trackOrdinal ?? 0);

  const exportText = generateExport(lap, packets, unit, temperatureUnit);
  const cornerData = buildCornerData(packets, corners, unit === "metric" ? "kmh" : "mph");

  // Run precomputed insight analysis
  const insights = analyzeLap(packets, lap.gameId ?? packets[0]?.gameId);
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
  // F1 setup comes from the `compare-f1-setup-to-catalog` tool — see the
  // Lap Analyst system prompt. Not injected here.

  let segmentsList = "";
  if (segments && segments.length > 0) {
    segmentsList = "\n--- Track Segments (use these EXACT names in braking/throttle/corners) ---\n";
    // Straights are numbered in lap order, so render the whole list at once
    // rather than per-segment — and label corners exactly as the map does.
    const labels = segmentDisplayNames(segments);
    segmentsList += segments
      .map((s, i) => `${s.type === "corner" ? "🔶" : "🔷"} ${labels[i]} (${(s.startFrac * 100).toFixed(1)}%-${(s.endFrac * 100).toFixed(1)}%)`)
      .join("\n");
    segmentsList += "\n";
  }

  // Sector times, split on this game's curated boundaries. Without the
  // boundaries the model can't tell which corners a slow sector covers.
  let sectorsText = "";
  if (sectors) {
    const { times, s1End, s2End } = sectors;
    const inSector = (n: 1 | 2 | 3) =>
      (segments ?? [])
        .filter((s) => {
          const mid = (s.startFrac + s.endFrac) / 2;
          return n === 1 ? mid < s1End : n === 2 ? mid >= s1End && mid < s2End : mid >= s2End;
        })
        .filter((s) => s.type === "corner")
        .map((s) => segmentDisplayName(s, 0))
        .join(", ");
    sectorsText = "\n--- Sector Times ---\n";
    for (const n of [1, 2, 3] as const) {
      const t = n === 1 ? times.s1 : n === 2 ? times.s2 : times.s3;
      const covers = inSector(n);
      sectorsText += `S${n}: ${t.toFixed(3)}s${covers ? ` — covers ${covers}` : ""}\n`;
    }
    sectorsText += `Boundaries: S1 ends at ${(s1End * 100).toFixed(1)}% of the lap, S2 at ${(s2End * 100).toFixed(1)}%.\n`;
  }

  const gameId: GameId = lap.gameId ?? packets[0]?.gameId;

  // Resolve the shared meta slug so the track guide can name corners the way
  // meta (and therefore the whitelist below) names them.
  const trackSlug =
    lap.trackOrdinal != null && gameId
      ? (tryGetServerGame(gameId)?.getSharedTrackName?.(lap.trackOrdinal) ?? undefined)
      : undefined;

  // Track grounding: the model invents corner names (e.g. "Bit-Kurve" at Lusail)
  // when nothing else constrains it. Build a whitelist from whatever named
  // sources we have; if none, force Tn numbering.
  // The guide's own labels must be in the whitelist too — it coaches by name,
  // so a name the whitelist omits is one the model is told to both use and not use.
  const cornerLabelWhitelist = collectCornerLabels(corners, segments, guideCornerLabels(trackName, { slug: trackSlug, gameId }));
  const cornerGuardrail =
    cornerLabelWhitelist.length > 0
      ? `\n--- Valid Corner Labels (the ONLY names you may use for corners in this output) ---\n${cornerLabelWhitelist.join(", ")}\n`
      : `\n--- Corner Naming ---\nNo named corner data is available for this track. Refer to corners as "T1", "T2", … based on sequence. Do NOT invent corner names.\n`;

  // Get car specs for additional context
  const carOrdinal = lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0;
  const specs = carSpecsMap.get(carOrdinal);
  let carDetailsText = `Car: ${carName}`;
  if (specs) {
    carDetailsText += `\nClass: ${specs.division}`;
    carDetailsText += `\nPerformance Index (PI): ${specs.pi}`;
    carDetailsText += `\nDimensions: ${specs.weightKg}kg, ${specs.hp}hp, ${specs.drivetrain}`;
  }

  const trackGuide = externalTrackGuide ?? buildTrackGuideContext(trackName, { slug: trackSlug, gameId });

  // Weather / surface conditions, so the model can attribute a slow lap to the
  // environment (cold, green, or wet track) rather than the driver or setup.
  const conditions = telemetryToTrackConditions(packets);
  const conditionsText = conditions
    ? `\n--- Track Conditions ---\n${formatTrackConditions(conditions)}\nWeigh these before blaming pace on the driver or setup — a cold, green, or wet surface costs grip everywhere.\n`
    : "";

  const context = `${carDetailsText}
Track: ${trackName}
${conditionsText}${tuneText}${segmentsList}${sectorsText}${cornerGuardrail}${trackGuide}
${exportText}
${cornerData}
${insightsText}`;

  const systemPrompt = getSystemPrompt(gameId, unit, temperatureUnit, language);

  // Build game-specific extended context via adapter
  let f1ExtendedContext = "";
  const serverAdapter = tryGetServerGame(gameId);
  if (serverAdapter?.buildAiContext && packets.length > 0) {
    f1ExtendedContext = serverAdapter.buildAiContext(packets);
  }

  const lapIdLine = lap.id !== undefined ? `Lap ID: ${lap.id}\n` : "";
  // Session type affects how the model should interpret strategy-dependent
  // signals (e.g. for F1 one-shot qualifying we expect ERS reserve near 0%
  // at the line; in race trim the same reading would be a red flag).
  const sessionType = packets[0]?.f1?.sessionType;
  const sessionTypeLine = sessionType ? `Session Type: ${sessionType}\n` : "";

  return `${systemPrompt}

--- TELEMETRY DATA ---

${lapIdLine}${sessionTypeLine}${context}${f1ExtendedContext}`;
}
