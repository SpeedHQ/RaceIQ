/**
 * System prompt for the compare-chat agent.
 * Provides comparison context; cached analyses are retrieved through the
 * visible get_lap_analysis tool call instead of being embedded here.
 */
import type { GameId } from "../../shared/games/ids";
import type { ComparisonResult } from "../lap-analysis/comparison";
import type { UnitSystem, TemperatureUnit } from "../lap-analysis/report";
import { getPromptCarName, getPromptTrackName, compareEngineerPersona, compareLapHeader } from "./compare-engineer";
import { buildSegmentTimingTable, type PromptSegment } from "./inputs-compare-prompt";
import { TRACK_GUIDE_PROMPT } from "../../shared/integrations/ai/prompt-snippets";
import { decodeAcEvoTrackId } from "../../shared/racing/tracks/ac-evo-identity";

interface LapInfo {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carId?: string | null;
  trackId?: string | null;
  gameId?: GameId;
}

function summarizeComparison(comp: ComparisonResult): string {
  const td = comp.timeDelta;
  if (!td.length) return "";
  const final = td[td.length - 1];
  let maxAhead = 0; // most negative (B ahead)
  let maxBehind = 0; // most positive (A ahead… wait, sign convention says positive = A slower / B gaining)
  let maxAheadIdx = 0;
  let maxBehindIdx = 0;
  for (let i = 0; i < td.length; i++) {
    if (td[i] < maxAhead) {
      maxAhead = td[i];
      maxAheadIdx = i;
    }
    if (td[i] > maxBehind) {
      maxBehind = td[i];
      maxBehindIdx = i;
    }
  }
  const distAtAhead = comp.distances[maxAheadIdx];
  const distAtBehind = comp.distances[maxBehindIdx];

  const corners = [...comp.cornerDeltas]
    .sort((a, b) => Math.abs(b.deltaSeconds) - Math.abs(a.deltaSeconds))
    .slice(0, 8);

  let out = `--- COMPARISON SUMMARY ---\n`;
  out += `Final time delta (A − B): ${final >= 0 ? "+" : ""}${final.toFixed(3)}s `;
  out += `(positive = A is slower)\n`;
  out += `Largest A-lead: ${maxAhead.toFixed(3)}s at ${distAtAhead.toFixed(0)}m\n`;
  out += `Largest B-lead: ${maxBehind.toFixed(3)}s at ${distAtBehind.toFixed(0)}m\n`;
  if (corners.length) {
    out += `Top corner deltas (A − B, seconds):\n`;
    for (const c of corners) {
      const sign = c.deltaSeconds >= 0 ? "+" : "";
      out += `  ${c.label}: ${sign}${c.deltaSeconds.toFixed(3)}s (A=${c.timeA.toFixed(3)}s, B=${c.timeB.toFixed(3)}s)\n`;
    }
  }
  return `${out}\n`;
}

export function buildCompareChatContext(
  lapA: LapInfo,
  lapB: LapInfo,
  comparison: ComparisonResult,
  segments: PromptSegment[] | null = null,
): string {
  const nativeStringGame = lapA.gameId === "acc" || lapA.gameId === "ac-evo";
  const carA = nativeStringGame ? lapA.carId ?? "" : getPromptCarName(Number(lapA.carId) || 0, lapA.gameId);
  const carB = nativeStringGame ? lapB.carId ?? "" : getPromptCarName(Number(lapB.carId) || 0, lapB.gameId);
  let trackName = nativeStringGame ? lapA.trackId ?? "" : getPromptTrackName(Number(lapA.trackId) || 0, lapA.gameId);
  if (lapA.gameId === "ac-evo" && lapA.trackId) {
    const pair = decodeAcEvoTrackId(lapA.trackId);
    if (pair) {
      const format = (value: string) => value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
      const configuration = pair[1].length <= 3 ? pair[1].toUpperCase() : format(pair[1]);
      trackName = [format(pair[0]), configuration].filter(Boolean).join(" - ");
    }
  }
  const finalDelta =
    comparison.timeDelta[comparison.timeDelta.length - 1] ??
    lapA.lapTime - lapB.lapTime;
  return `${compareLapHeader(trackName, carA, carB, lapA, lapB, finalDelta)}
${summarizeComparison(comparison)}

SERVER-AUTHORITATIVE PER-SEGMENT TIMINGS (positive Δ = Lap A slower):
${buildSegmentTimingTable(comparison, segments)}

Use these computed deltas as authoritative. Explain why they differ using telemetry/tools; do not recalculate or invent timing deltas.
Use the retrieved analyses and the corner-by-corner deltas to explain where time is gained or lost and what the slower lap should change.`;
}

export function buildCompareChatSystemPrompt(
  lapA: LapInfo,
  lapB: LapInfo,
  comparison: ComparisonResult,
  unit?: UnitSystem,
  temperatureUnit?: TemperatureUnit,
  language?: string,
): string;
export function buildCompareChatSystemPrompt(
  lapA: LapInfo,
  lapB: LapInfo,
  comparison: ComparisonResult,
  analysisJsonA: string | null | undefined,
  analysisJsonB: string | null | undefined,
  unit?: UnitSystem,
  temperatureUnit?: TemperatureUnit,
  language?: string,
  precomputedInsights?: string,
): string;
export function buildCompareChatSystemPrompt(
  lapA: LapInfo,
  lapB: LapInfo,
  comparison: ComparisonResult,
  unitOrAnalysisA: UnitSystem | string | null = "metric",
  temperatureOrAnalysisB: TemperatureUnit | string | null = "C",
  languageOrUnit: string | UnitSystem = "en",
  legacyTemperature?: TemperatureUnit,
  legacyLanguage = "en",
): string {
  const isCurrent = unitOrAnalysisA === "metric" || unitOrAnalysisA === "imperial";
  const unit: UnitSystem = isCurrent
    ? unitOrAnalysisA
    : languageOrUnit === "imperial"
      ? "imperial"
      : "metric";
  const temperatureUnit: TemperatureUnit = isCurrent
    ? temperatureOrAnalysisB === "F"
      ? "F"
      : "C"
    : legacyTemperature ?? (unit === "metric" ? "C" : "F");
  const language = isCurrent
    ? typeof languageOrUnit === "string" && languageOrUnit !== "metric" && languageOrUnit !== "imperial"
      ? languageOrUnit
      : "en"
    : legacyLanguage;
  const nativeStringGame = lapA.gameId === "acc" || lapA.gameId === "ac-evo";
  const carA = nativeStringGame ? lapA.carId ?? "" : getPromptCarName(Number(lapA.carId) || 0, lapA.gameId);
  const carB = nativeStringGame ? lapB.carId ?? "" : getPromptCarName(Number(lapB.carId) || 0, lapB.gameId);
  const trackName = nativeStringGame ? lapA.trackId ?? "" : getPromptTrackName(Number(lapA.trackId) || 0, lapA.gameId);
  const finalDelta =
    comparison.timeDelta[comparison.timeDelta.length - 1] ??
    lapA.lapTime - lapB.lapTime;
  return `${compareEngineerPersona(unit, temperatureUnit, language)}${TRACK_GUIDE_PROMPT}

INITIALIZATION PROTOCOL — MUST COMPLETE BEFORE ANY TEXT

For the first assistant turn in this comparison thread:
1. Do not answer, acknowledge, greet, or explain.
2. Call \`get_lap_analysis\` with \`lapId: ${lapA.id}\`.
3. Call \`get_lap_analysis\` with \`lapId: ${lapB.id}\`.
4. Call \`get_compare_analysis\` with \`lapAId: ${lapA.id}\` and \`lapBId: ${lapB.id}\`.
5. Wait for all three tool results before producing any text.
6. If any result is unavailable, state that limitation and do not infer missing findings.

The required call order is: get_lap_analysis(${lapA.id}), get_lap_analysis(${lapB.id}), get_compare_analysis(${lapA.id}, ${lapB.id}). Do not substitute the comparison summary below for get_compare_analysis. Never claim a tool was called unless its tool result exists. If the first user message is only a greeting, still run this protocol.

This task: free-form chat. The driver will ask you questions about how the two laps compare. Be brief and use bullet points where helpful. NO JSON output — write conversational answers.

${compareLapHeader(trackName, carA, carB, lapA, lapB, finalDelta)}

${summarizeComparison(comparison)}
Use the retrieved analyses and the corner-by-corner deltas to explain where time is gained or lost and what the slower lap should change.`;
}
