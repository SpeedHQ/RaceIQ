/**
 * System prompt for the compare-chat agent.
 * Embeds both laps' cached analyses + the comparison summary so the agent
 * can reason across the two laps without re-running analysis.
 */
import type { GameId } from "../../shared/types";
import type { ComparisonResult } from "../comparison";
import type { UnitSystem } from "../export";
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

function summarizeAnalysis(label: string, analysisJson: string | null | undefined): string {
  if (!analysisJson) return `${label}: (no analysis cached)\n`;
  try {
    const a = JSON.parse(analysisJson);
    let out = `${label}\n  Verdict: ${a.verdict ?? "—"}\n`;
    if (a.pace?.length) {
      out += `  Pace: ${a.pace.map((p: any) => `${p.label}=${p.value} (${p.assessment})`).join(", ")}\n`;
    }
    if (a.handling?.length) {
      out += `  Handling: ${a.handling.map((h: any) => `${h.label}=${h.value} (${h.assessment})`).join(", ")}\n`;
    }
    if (a.corners?.length) {
      out += `  Problem corners: ${a.corners.map((c: any) => `${c.name} [${c.severity}] — ${c.issue} → ${c.fix}`).join("; ")}\n`;
    }
    if (a.braking?.length) {
      out += `  Braking: ${a.braking.map((b: any) => `${b.corner} (${b.assessment}) ${b.brakePoint}`).join("; ")}\n`;
    }
    if (a.throttle?.length) {
      out += `  Throttle: ${a.throttle.map((t: any) => `${t.corner} (${t.assessment}) ${t.throttlePoint}`).join("; ")}\n`;
    }
    if (a.coaching?.length) {
      out += `  Coaching: ${a.coaching.map((c: any) => c.tip).join("; ")}\n`;
    }
    if (a.setup?.length) {
      out += `  Setup hints: ${a.setup.map((s: any) => `${s.component} ${s.current}→${s.target}`).join("; ")}\n`;
    }
    return out;
  } catch {
    return `${label}\n${analysisJson}\n`;
  }
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
    if (td[i] < maxAhead) { maxAhead = td[i]; maxAheadIdx = i; }
    if (td[i] > maxBehind) { maxBehind = td[i]; maxBehindIdx = i; }
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
  analysisJsonA: string | null | undefined,
  analysisJsonB: string | null | undefined,
  unit: UnitSystem = "metric",
): string {
  const carA = getCarName(lapA.carOrdinal ?? 0);
  const carB = getCarName(lapB.carOrdinal ?? 0);
  const trackName = getTrackName(lapA.trackOrdinal ?? 0);
  const finalDelta = comparison.timeDelta[comparison.timeDelta.length - 1] ?? (lapA.lapTime - lapB.lapTime);

  return `${compareEngineerPersona(unit)}

This task: free-form chat. The driver will ask you questions about how the two laps compare. Be brief and use bullet points where helpful. NO JSON output — write conversational answers.

${compareLapHeader(trackName, carA, carB, lapA, lapB, finalDelta)}

${summarizeComparison(comparison)}--- LAP A ANALYSIS (already shown to driver) ---
${summarizeAnalysis("Lap A", analysisJsonA)}
--- LAP B ANALYSIS (already shown to driver) ---
${summarizeAnalysis("Lap B", analysisJsonB)}
Use both analyses and the corner-by-corner deltas to explain where time is gained or lost and what the slower lap should change.`;
}
