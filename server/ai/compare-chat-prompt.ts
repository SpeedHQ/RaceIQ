/**
 * System prompt for the compare-chat agent.
 * Provides comparison context; cached analyses are retrieved through the
 * visible get_lap_analysis tool call instead of being embedded here.
 */
import type { GameId } from "../../shared/types";
import type { ComparisonResult } from "../comparison";
import type { UnitSystem, TemperatureUnit } from "../export";
import { getCarName, getTrackName } from "../../shared/car-data";
import { compareEngineerPersona, compareLapHeader } from "./compare-engineer";

interface LapInfo {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal?: number;
  trackOrdinal?: number;
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
  return out + "\n";
}

export function buildCompareChatSystemPrompt(
  lapA: LapInfo,
  lapB: LapInfo,
  comparison: ComparisonResult,
  unit: UnitSystem = "metric",
  temperatureUnit: TemperatureUnit = unit === "metric" ? "C" : "F",
  /** UI/AI language code (e.g. "en", "de"). Steers prose language. */
  language: string = "en",
): string {
  const carA = getCarName(lapA.carOrdinal ?? 0);
  const carB = getCarName(lapB.carOrdinal ?? 0);
  const trackName = getTrackName(lapA.trackOrdinal ?? 0);
  const finalDelta =
    comparison.timeDelta[comparison.timeDelta.length - 1] ??
    lapA.lapTime - lapB.lapTime;

  return `${compareEngineerPersona(unit, temperatureUnit, language)}

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
