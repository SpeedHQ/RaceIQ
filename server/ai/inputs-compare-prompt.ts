/**
 * Builds the AI prompt for comparing the driver inputs (throttle, brake, steering)
 * of two laps, broken down per track segment. Consumes the aligned 1-meter traces
 * from `compareLaps` plus a list of named segments (corners + straights).
 */
import { z } from "zod";
import type { ComparisonResult } from "../lap-analysis/comparison";
import { getPromptCarName, getPromptTrackName, compareLapHeader } from "./compare-engineer";
import type { GameId } from "../../shared/games/ids";
import { buildTrackGuideContext } from "./track-guides";
import { resolveTrack } from "../tracks/info";
import { segmentPromptNames } from "../../shared/racing/tracks/segment-label";
import { computeStatsRange, steerScaleFor, type InputStats } from "../lap-analysis/metrics";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { buildQualityPromptContext } from "./quality-context";

/**
 * Zod schema for the per-segment inputs comparison output.
 *
 * `type` (corner/straight) is NOT asked of the model — it is deterministic and
 * gets merged in post-response from the source segment definition. This avoids
 * the common failure where the model marks real corners as "straight".
 */
export const InputsCompareSchema = z.object({
  verdict: z.string().describe("1-2 sentence top-line summary of input differences across the lap."),
  segments: z
    .array(
      z.object({
        name: z.string().describe("Segment name from the prompt's segment list."),
        deltaSeconds: z.number().describe("Lap A time minus Lap B time for this segment, in seconds. Positive = A slower."),
        throttle: z.string().describe("1 sentence on throttle input differences."),
        brake: z.string().describe("1 sentence on brake input differences."),
        steering: z.string().describe("1 sentence on steering input differences."),
        action: z
          .string()
          .describe(
            "1 short imperative sentence telling the slower driver what to change in this segment. MUST include at least one concrete numeric value (meters, km/h, %, seconds, or gear). Examples: 'Brake 10m later and release 0.2s earlier into the apex.', 'Carry 4 km/h more minimum corner speed.', 'Hit 100% throttle 15m earlier on exit.' Target the slower lap.",
          ),
        severity: z.enum(["minor", "moderate", "major"]),
      }),
    )
    .min(1)
    .describe("ONE entry per track segment, in the order given by the prompt. MUST NOT be empty."),
  coaching: z.array(
    z.object({
      tip: z.string(),
      detail: z.string(),
      targetLap: z.enum(["A", "B"]),
    }),
  ),
});

export type InputsCompareResult = z.infer<typeof InputsCompareSchema>;

interface LapInfo {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal?: number;
  trackOrdinal?: number;
  gameId?: GameId;
  quality?: LapQualitySummary | null;
  eligibility?: EligibilityDecisionSet | null;
  qualityGeneration?: string | null;
}

export interface PromptSegment {
  name: string;
  type: "corner" | "straight";
  startFrac: number;
  endFrac: number;
  /** Official turn numbering this section accounts for (#84). Renders "T2-4 Name". */
  number?: number;
  covers?: number[];
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function mOrDash(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(0)}m`;
}

function statsLine(label: string, s: InputStats): string {
  const lines = [
    `${label}: thr avg ${pct(s.throttleAvg)}/max ${pct(s.throttleMax)}/full ${pct(s.fullThrottlePctDist)} | brk avg ${pct(s.brakeAvg)}/max ${pct(s.brakeMax)}/on ${pct(s.brakingPctDist)}/${s.brakeApplications}ev | str |avg| ${pct(s.steerAbsAvg)}/|max| ${pct(s.steerAbsMax)}/Δ${s.steeringSmoothness.toFixed(3)}`,
    `${label} events: brake_on @${mOrDash(s.brakeOnDist)}, brake_off @${mOrDash(s.brakeOffDist)}, peak_brake ${pct(s.peakBrakeValue)} @${mOrDash(s.peakBrakeDist)}, full_throttle @${mOrDash(s.fullThrottleDist)}, lift_off_throttle @${mOrDash(s.liftOffThrottleDist)}`,
    `${label} speed: min ${s.minSpeed.toFixed(1)} km/h @${mOrDash(s.minSpeedDist)}, max ${s.maxSpeed.toFixed(1)} km/h @${mOrDash(s.maxSpeedDist)}`,
  ];
  return lines.join("\n  ");
}

/** Render a clean tabular view of per-segment timings + delta. */
function formatSegmentTable(
  rows: {
    name: string;
    type: string;
    timeA: number;
    timeB: number;
    delta: number;
  }[],
): string {
  if (rows.length === 0) return "(no segments)";
  const nameW = Math.max(8, ...rows.map((r) => r.name.length + (r.type === "corner" ? 2 : 0)));
  const header = `${"Segment".padEnd(nameW)}  ${"A".padStart(8)}  ${"B".padStart(8)}  ${"+/-".padStart(8)}`;
  const sep = "-".repeat(header.length);
  const lines = rows.map((r) => {
    const label = r.type === "corner" ? `${r.name}*` : r.name; // mark corners with *
    const a = r.timeA.toFixed(3);
    const b = r.timeB.toFixed(3);
    const sign = r.delta >= 0 ? "+" : "";
    const d = `${sign}${r.delta.toFixed(3)}`;
    return `${label.padEnd(nameW)}  ${a.padStart(8)}  ${b.padStart(8)}  ${d.padStart(8)}`;
  });
  return [header, sep, ...lines, "(* = corner)"].join("\n");
}

/** Build server-authoritative per-segment timing rows for any compare flow. */
export function buildSegmentTimingTable(comparison: ComparisonResult, segments: PromptSegment[] | null): string {
  const useSegs = segments && segments.length > 0 ? segments : fallbackSegments(8);
  const distances = comparison.distances;
  const totalDist = distances[distances.length - 1] - distances[0] || 1;
  const startDist = distances[0] ?? 0;
  const labels = segmentPromptNames(useSegs);
  const rows: { name: string; type: string; timeA: number; timeB: number; delta: number }[] = [];

  for (const [index, segment] of useSegs.entries()) {
    const startD = startDist + segment.startFrac * totalDist;
    const endD = startDist + segment.endFrac * totalDist;
    let lo = 0;
    while (lo < distances.length && distances[lo] < startD) lo++;
    let hi = lo;
    while (hi < distances.length && distances[hi] < endD) hi++;
    if (hi - lo < 2) continue;
    const timeA = (comparison.lapA.elapsedTime[hi - 1] ?? 0) - (comparison.lapA.elapsedTime[lo] ?? 0);
    const timeB = (comparison.lapB.elapsedTime[hi - 1] ?? 0) - (comparison.lapB.elapsedTime[lo] ?? 0);
    rows.push({ name: labels[index], type: segment.type, timeA, timeB, delta: timeA - timeB });
  }

  return formatSegmentTable(rows);
}

/** Synthesise evenly spaced segments when the track has no metadata. */
function fallbackSegments(count: number): PromptSegment[] {
  const segs: PromptSegment[] = [];
  for (let i = 0; i < count; i++) {
    segs.push({
      name: `Section ${i + 1}`,
      type: "straight",
      startFrac: i / count,
      endFrac: (i + 1) / count,
    });
  }
  return segs;
}

/**
 * Builds the USER message for the inputs-compare flow: the task, the output
 * requirements, and the telemetry data.
 *
 * Deliberately carries no persona, units, or language instruction — those
 * belong in the system message, which compareEngineerAgent supplies from
 * settings. Passing them here as well shipped the persona twice per request.
 */
export function buildInputsComparePrompt(
  lapA: LapInfo,
  lapB: LapInfo,
  comparison: ComparisonResult,
  segments: PromptSegment[] | null,
  /** Pre-fetched track guide text. When provided, skips internal lookup. */
  externalTrackGuide?: string,
  /** Per-lap precomputed insight blocks (see buildCompareInsightsBlock). */
  precomputedInsights?: string,
): string {
  const carA = getPromptCarName(lapA.carOrdinal ?? 0, lapA.gameId);
  const carB = getPromptCarName(lapB.carOrdinal ?? 0, lapB.gameId);
  const trackName = getPromptTrackName(lapA.trackOrdinal ?? 0, lapA.gameId);
  const { slug } = resolveTrack(lapA.gameId, lapA.trackOrdinal);
  const trackGuide = externalTrackGuide ?? buildTrackGuideContext(trackName, { slug });
  const finalDelta = comparison.timeDelta[comparison.timeDelta.length - 1] ?? 0;

  const useSegs = segments && segments.length > 0 ? segments : fallbackSegments(8);

  // Steering is raw game units in the traces; each lap normalises with its own
  // game's convention (the two laps can come from different games).
  const steerScaleA = steerScaleFor(lapA.gameId);
  const steerScaleB = steerScaleFor(lapB.gameId);

  const distances = comparison.distances;
  const totalDist = distances[distances.length - 1] - distances[0] || 1;
  const startDist = distances[0];

  // For each segment, compute per-lap stats + segment time delta
  // Also build a clean tabular row so the model sees segment timing as concrete data.
  const segLines: string[] = [];
  const tableRows: {
    name: string;
    type: string;
    timeA: number;
    timeB: number;
    delta: number;
  }[] = [];
  // Label corners exactly as the analyst prompt and the expert guide do — "Eau
  // Rouge/Raidillon (2-4)", not the map's "T2-4 Eau Rouge/Raidillon" — so every
  // part of the prompt refers to a corner by the same string. Per *entry*, not
  // per piece: each row below is one timed segment, so a grouped complex needs
  // a label on every apex rather than a blank after the first.
  const segLabels = segmentPromptNames(useSegs);
  for (const [segIdx, seg] of useSegs.entries()) {
    const segLabel = segLabels[segIdx];
    const startD = startDist + seg.startFrac * totalDist;
    const endD = startDist + seg.endFrac * totalDist;
    // Find indices via linear scan (distances is monotonic)
    let lo = 0;
    while (lo < distances.length && distances[lo] < startD) lo++;
    let hi = lo;
    while (hi < distances.length && distances[hi] < endD) hi++;
    if (hi - lo < 2) continue;

    const elA = comparison.lapA.elapsedTime;
    const elB = comparison.lapB.elapsedTime;
    const segTimeA = (elA[hi - 1] ?? 0) - (elA[lo] ?? 0);
    const segTimeB = (elB[hi - 1] ?? 0) - (elB[lo] ?? 0);
    const segDelta = segTimeA - segTimeB;

    const sA = computeStatsRange(comparison.lapA.throttle, comparison.lapA.brake, comparison.lapA.steer, comparison.lapA.speed, distances, lo, hi, steerScaleA);
    const sB = computeStatsRange(comparison.lapB.throttle, comparison.lapB.brake, comparison.lapB.steer, comparison.lapB.speed, distances, lo, hi, steerScaleB);

    // Fuel + tire health snapshot at segment start/end (tire health = 1 - wear)
    const fuelStartA = comparison.lapA.fuel[lo] ?? 0;
    const fuelEndA = comparison.lapA.fuel[hi - 1] ?? 0;
    const fuelStartB = comparison.lapB.fuel[lo] ?? 0;
    const fuelEndB = comparison.lapB.fuel[hi - 1] ?? 0;
    const tireStartA = 1 - (comparison.lapA.tireWear[lo] ?? 0);
    const tireEndA = 1 - (comparison.lapA.tireWear[hi - 1] ?? 0);
    const tireStartB = 1 - (comparison.lapB.tireWear[lo] ?? 0);
    const tireEndB = 1 - (comparison.lapB.tireWear[hi - 1] ?? 0);

    tableRows.push({
      name: segLabel,
      type: seg.type,
      timeA: segTimeA,
      timeB: segTimeB,
      delta: segDelta,
    });

    const startMeters = (startD - startDist).toFixed(0);
    const endMeters = (endD - startDist).toFixed(0);
    const sgn = segDelta >= 0 ? "+" : "";
    segLines.push(
      `[${segLabel}] (${seg.type}, ${startMeters}-${endMeters}m) Δ=${sgn}${segDelta.toFixed(3)}s A=${segTimeA.toFixed(3)}s B=${segTimeB.toFixed(3)}s
  ${statsLine("A", sA)}
  ${statsLine("B", sB)}
  Fuel:        A ${pct(fuelStartA)}→${pct(fuelEndA)} (Δ${pct(fuelStartA - fuelEndA)})  |  B ${pct(fuelStartB)}→${pct(fuelEndB)} (Δ${pct(fuelStartB - fuelEndB)})
  Tire health: A ${pct(tireStartA)}→${pct(tireEndA)} (Δ${pct(tireStartA - tireEndA)})  |  B ${pct(tireStartB)}→${pct(tireEndB)} (Δ${pct(tireStartB - tireEndB)})`,
    );
  }

  // Build the explicit list of expected segment names so the model can't forget them
  const segNames = segLabels.map((l) => `"${l}"`).join(", ");
  const expectedCount = useSegs.length;
  const qualityContextA = buildQualityPromptContext(lapA, ["lap-comparison", "corner-trace", "transient-event"]);
  const qualityContextB = buildQualityPromptContext(lapB, ["lap-comparison", "corner-trace", "transient-event"]);

  // No persona prefix here: this string is sent as the USER message, and
  // compareEngineerAgent already carries the persona (built from the same
  // settings) as its system instructions. Prepending it here shipped the whole
  // persona twice in every request.
  return `This task: produce a structured per-segment comparison of driver inputs (throttle, brake, steering) plus coaching for the slower lap.

CRITICAL OUTPUT REQUIREMENTS:
- Your "segments" array MUST contain EXACTLY ${expectedCount} entries.
- Each entry's "name" must match one of these values, in this exact order: [${segNames}].
- Do NOT skip segments. Do NOT add extra segments. Do NOT return an empty segments array.
- Even if A and B are nearly identical in a segment, output an entry saying so (severity: "minor").

Output JSON only with this exact shape:
{
  "verdict": "1-2 sentence top-line summary of input differences across the lap",
  "segments": [
    {
      "name": "<one of the segment names listed above>",
      "deltaSeconds": -0.123,
      "throttle": "1 sentence on throttle differences in this segment",
      "brake": "1 sentence on brake differences",
      "steering": "1 sentence on steering differences",
      "action": "1 short imperative sentence telling the slower driver exactly what to change in this segment",
      "severity": "minor" | "moderate" | "major"
    }
  ],
  "coaching": [
    { "tip": "actionable change", "detail": "why and how", "targetLap": "A" | "B" }
  ]
}

Rules:
- "severity" reflects how meaningful the input difference is in that segment, NOT the time delta magnitude.
- Use percentages for throttle/brake (e.g. "75% throttle"), describe steering as smoother/more aggressive/earlier/later.
- "action" must be a concrete imperative directed at the slower driver for this segment. It MUST contain at least one actionable numeric value — a distance (m), speed (km/h / mph), percentage (throttle/brake %), time (s), or gear. Vague instructions ("brake later", "be smoother") are NOT acceptable; you must quantify the change using the data in this segment. Examples: "Brake 12m later and release 0.2s earlier into the apex.", "Carry 4 km/h more minimum corner speed at 240m.", "Hit 100% throttle 15m earlier on exit (currently at 75% until 180m).". If both laps are essentially identical in this segment, say "Keep current technique" (no number required in that case only).
- Top-level "coaching" is for the overall lap, max 5 tips, target the slower lap unless a meaningful issue exists on the faster lap.

${compareLapHeader(trackName, carA, carB, lapA, lapB, finalDelta)}
Lap A:
${qualityContextA}
Lap B:
${qualityContextB}
${trackGuide}
Per-segment timings (positive Δ = Lap A is slower):
${formatSegmentTable(tableRows)}

Per-segment notes:
- Each segment has three per-lap data rows: aggregates, events, and speed.
- "events" row: brake_on / brake_off / peak_brake (with %) / full_throttle / lift_off_throttle — each with an absolute lap distance in meters. Subtract A's value from B's to compute concrete deltas like "brake 12m later" or "reach full throttle 9m earlier".
- "speed" row: minimum and maximum speed in km/h with the distance where each occurred. Use these to say "carry 4 km/h more minimum corner speed" type actions.
- "Fuel" lines show fuel level at the start and end of the segment plus consumption Δ. Use these to comment on whether one driver is burning more fuel through a section.
- "Tire health" lines show tire health at the start and end of the segment (100% = fresh). Comment on differences in degradation if meaningful.

To produce a concrete "action", you MUST diff the events/speed rows between Lap A and Lap B for the same segment and quote the resulting numbers. If the slower lap brakes 120m into a corner and the faster lap brakes at 132m, the action is "Brake 12m later into T1 (current brake point 120m, target 132m)." Do not produce actions without such numeric evidence.

${precomputedInsights ?? ""}
Segments to analyse (${expectedCount} total — produce EXACTLY ${expectedCount} entries in your "segments" array):
${segLines.join("\n\n")}`;
}
