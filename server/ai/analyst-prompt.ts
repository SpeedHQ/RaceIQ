import type { FindingRecord } from "../../shared/racing/findings/types";

import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { Tune } from "../../shared/racing/tuning/types";
import type { GameId } from "../../shared/games/ids";
import { generateExport, type UnitSystem, type TemperatureUnit } from "../lap-analysis/report";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { buildQualityPromptContext } from "./quality-context";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { fmCarSpecsCatalog } from "../../shared/racing/cars/fm";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { buildCornerData } from "./corner-data";
import { assessLapRecording } from "../lap-analysis/quality";
import { buildFindingsContext } from "./findings-context";
import { formatTuneForPrompt } from "./format-tune";
import { tryGetServerGame } from "../games/registry";
import { resolveTrack } from "../tracks/info";
import { buildTrackGuideContext, guideCornerLabels } from "./track-guides";
import { telemetryToTrackConditions, formatTrackConditions } from "./track-conditions";
import { segmentPromptLabels } from "../../shared/racing/tracks/segment-label";
import { aiLanguageInstruction } from "../../shared/integrations/ai/language";
import { ADJUSTMENT_FORMAT_PROMPT } from "../../shared/integrations/ai/prompt-snippets";
interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

/**
 * A curated track segment (#84) as the prompt consumes it. `number`/`covers`
 * are the official turn numbers the section accounts for — they're what makes
 * "T2-4 Eau Rouge/Raidillon" rather than a bare name, so pass them through.
 *
 * `group` matters for the same reason: `segmentPromptLabels` collapses a
 * complex to one label, and dropping the field here silently turned that
 * collapse into a no-op on this path while it still fired in `track-guides.ts`,
 * so the model was handed two different label sets for the same corners.
 */
export interface PromptSegment {
  type: string;
  name: string;
  startFrac: number;
  endFrac: number;
  number?: number;
  covers?: number[];
  group?: string;
  direction?: "left" | "right";
}
export interface PromptSectors {
  times: number[];
  sectorStarts: number[];
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
    // segmentPromptLabels, not s.name: the track map and the expert guide both
    // label this corner "Eau Rouge/Raidillon (2-4)" — one entry per piece, with
    // a group collapsed onto its first member. Whitelisting the bare name would
    // leave the model told to use a label that isn't on the list.
    const labels = segmentPromptLabels(segments);
    segments.forEach((s, i) => {
      if (s.type === "corner") push(labels[i]);
    });
  }
  if (guideLabels) for (const l of guideLabels) push(l);
  return out;
}

const GENERIC_ANALYST_SYSTEM_PROMPT = `You are a simulator-neutral racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback without assuming which simulator produced it.

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
    { "component": "setup component explicitly present in provided data", "symptom": "what the telemetry shows", "fix": "evidence-backed adjustment and why", "current": "provided current value with unit", "target": "supported target value with unit", "direction": "increase|decrease|adjust" }
  ]
}

CATEGORY GUIDELINES:
- "pace": 4-6 items covering speed, throttle %, braking efficiency, full-throttle time, gear usage.
- "handling": 4-6 items covering suspension travel, tire temps, tire wear balance, oversteer/understeer, weight transfer.
- "corners": Top 3-5 problem corners where time is being lost. Include speed numbers.
- "braking": Per-corner braking analysis for every corner in the corner data. Use corner label names exactly. "good" = no issues. If detail describes a problem, MUST be "warning" or "critical".
- "throttle": Per-corner throttle analysis for every corner. Use corner label names exactly. "good" = clean application. If detail describes a problem, MUST be "warning" or "critical".
- "coaching": 3-5 actionable driving tips. Reference specific telemetry values.
- "setup": 0-8 evidence-backed adjustments. Include a component only when tune data or supplied game context explicitly establishes that it is adjustable. If no such setup data is provided, return an empty array.

RULES:
- Reference specific numbers from the data — don't be vague
- Use the driver's preferred units: {{UNITS}}
- Be specific and actionable, not generic
- Address the driver as "you"
- When tune settings are provided, correlate telemetry symptoms with those actual setup values
- Never invent game-specific setup options, current values, target values, units, adjustment granularity, valid ranges, or tuning rules
- Do not assume simulator-specific setup semantics; omit unsupported setup claims instead
- Output ONLY valid JSON, nothing else
- Escape any special characters in string values (quotes, newlines)
- Do not include trailing commas in arrays or objects`;

function getSystemPrompt(gameId: GameId, unit: UnitSystem, temperatureUnit: TemperatureUnit, language: string): string {
  const speedDistanceWeight = unit === "metric" ? "km/h, meters, kg, bar" : "mph, feet, lb, psi";
  const units = `${speedDistanceWeight}, °${temperatureUnit}`;
  const adapter = tryGetServerGame(gameId);
  const base = adapter ? adapter.aiSystemPrompt : GENERIC_ANALYST_SYSTEM_PROMPT;
  return `${base.replace("{{UNITS}}", units)}\n- Temperature unit in this session: °${temperatureUnit}${ADJUSTMENT_FORMAT_PROMPT}${aiLanguageInstruction(language, { json: true })}`;
}

export function buildAnalystPrompt(
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
  sectors?: PromptSectors,
  /** Persisted deterministic records for this lap's current generation. */
  storedFindings?: readonly FindingRecord[],
): string {
  const carName = resolveCarName(lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0, lap.gameId);
  const trackName = resolveTrackName(lap.trackOrdinal ?? 0, lap.gameId);

  // F1 uses adapter-specific compact context; generic export is Forza-specific.
  const exportText = lap.gameId === "f1-2025" ? "" : generateExport(lap, packets, unit, temperatureUnit);
  const cornerData = buildCornerData(packets, corners, unit === "metric" ? "kmh" : "mph");

  const quality = assessLapRecording(packets, lap.lapTime);
  const findingsContext = storedFindings ? buildFindingsContext(storedFindings) : "";
  const qualityAbstention = quality.valid
    ? ""
    : `[ABSTENTION] Lap recording quality rejected: ${quality.reason ?? "unknown reason"}; do not make lap-performance claims from this telemetry.`;
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
  // F1 setup comes from the `compare-f1-setup-to-catalog` tool — see the
  // Lap Analyst system prompt. Not injected here.

  let segmentsList = "";
  if (segments && segments.length > 0) {
    segmentsList = "\n--- Track Segments (use these EXACT names in braking/throttle/corners) ---\n";
    // Straights are numbered in lap order, so render the whole list at once
    // rather than per-segment — and label corners exactly as the map does.
    // A group collapses onto its first member ("" for the rest), so skip the
    // blanks — the grouped piece is already listed once, spanning its members.
    const labels = segmentPromptLabels(segments);
    segmentsList += segments
      .map((s, i) => (labels[i] ? `${s.type === "corner" ? "🔶" : "🔷"} ${labels[i]} (${(s.startFrac * 100).toFixed(1)}%-${(s.endFrac * 100).toFixed(1)}%)` : ""))
      .filter((line) => line !== "")
      .join("\n");
    segmentsList += "\n";
  }

  // Sector times, split on this game's curated boundaries. Without the
  // boundaries the model can't tell which corners a slow sector covers.
  let sectorsText = "";
  if (sectors) {
    const { times, sectorStarts } = sectors;
    const all = segments ?? [];
    const sectorLabels = segmentPromptLabels(all);
    const inSector = (index: number) =>
      all
        .map((s, i) => ({ s, label: sectorLabels[i] }))
        .filter(({ s, label }) => {
          if (s.type !== "corner" || !label) return false;
          const mid = (s.startFrac + s.endFrac) / 2;
          const start = sectorStarts[index];
          const end = sectorStarts[index + 1] ?? 1;
          return mid >= start && mid < end;
        })
        .map(({ label }) => label)
        .join(", ");
    sectorsText = "\n--- Sector Times ---\n";
    for (let index = 0; index < times.length; index++) {
      const n = index + 1;
      const t = times[index];
      const covers = inSector(index);
      sectorsText += `S${n}: ${t.toFixed(3)}s${covers ? ` — covers ${covers}` : ""}\n`;
    }
    const boundaries = sectorStarts.slice(1).map((start, index) => `S${index + 1} ends at ${(start * 100).toFixed(1)}%`);
    sectorsText += `Boundaries: ${boundaries.join(", ")} of the lap.\n`;
  }

  const gameId: GameId = lap.gameId ?? packets[0]?.gameId;

  const { slug } = resolveTrack(gameId, lap.trackOrdinal);

  // Track grounding: the model invents corner names (e.g. "Bit-Kurve" at Lusail)
  // when nothing else constrains it. Build a whitelist from whatever named
  // sources we have; if none, force Tn numbering.
  // The guide's own labels must be in the whitelist too — it coaches by name,
  // so a name the whitelist omits is one the model is told to both use and not use.
  const cornerLabelWhitelist = collectCornerLabels(corners, segments, guideCornerLabels(trackName, { slug }));
  const cornerGuardrail =
    cornerLabelWhitelist.length > 0
      ? `\n--- Valid Corner Labels (the ONLY names you may use for corners in this output) ---\n${cornerLabelWhitelist.join(", ")}\n`
      : `\n--- Corner Naming ---\nNo named corner data is available for this track. Refer to corners as "T1", "T2", … based on sequence. Do NOT invent corner names.\n`;

  // Get car specs for additional context
  const carOrdinal = lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0;
  const specs = fmCarSpecsCatalog.get(carOrdinal);
  let carDetailsText = `Car: ${carName}`;
  if (specs) {
    carDetailsText += `\nClass: ${specs.division}`;
    carDetailsText += `\nPerformance Index (PI): ${specs.pi}`;
    carDetailsText += `\nDimensions: ${specs.weightKg}kg, ${specs.hp}hp, ${specs.drivetrain}`;
  }

  const trackGuide = externalTrackGuide ?? buildTrackGuideContext(trackName, { slug });

  // Weather / surface conditions, so the model can attribute a slow lap to the
  // environment (cold, green, or wet track) rather than the driver or setup.
  const conditions = telemetryToTrackConditions(packets);
  const conditionsText = conditions
    ? `\n--- Track Conditions ---\n${formatTrackConditions(conditions)}\nWeigh these before blaming pace on the driver or setup — a cold, green, or wet surface costs grip everywhere.\n`
    : "";
  const qualityContext = buildQualityPromptContext(lap, ["official-timing", "normal-pace", "corner-trace", "transient-event", "fuel-burn", "tire-analysis"]);

  const context = `${carDetailsText}
Track: ${trackName}
${qualityContext}
${conditionsText}${tuneText}${segmentsList}${sectorsText}${cornerGuardrail}${trackGuide}
${exportText}
${cornerData}
${findingsText ? `\n${findingsText}` : ""}`;

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
