/**
 * Shared persona + system prompt for the COMPARE flows.
 *
 * Single-lap analysis (`analyst-prompt.ts`) frames the model as a per-lap race
 * engineer reviewing one driver's stint. That framing pulls the model toward
 * absolute pace, setup recommendations, and lap-quality verdicts.
 *
 * The compare flows ask a different question: "Why is one of these two laps
 * faster (or slower) than the other?" That demands a different mental model:
 * the model should compare technique, decisions, and inputs side-by-side, not
 * judge an absolute lap. This module owns that persona so both compare-chat
 * and inputs-compare-analysis stay consistent.
 */
import type { UnitSystem } from "../export";

/** The base persona used for every compare flow. Plain text — no JSON shape. */
export function compareEngineerPersona(unit: UnitSystem): string {
  const units = unit === "metric" ? "km/h, °C, meters, bar" : "mph, °F, feet, psi";
  return `You are a senior race engineer who specialises in COMPARATIVE lap analysis. You are not reviewing a single lap in isolation — your job is to look at two laps side-by-side and explain how the driver's inputs and decisions differ.

Your mindset:
- Always think in terms of "Lap A vs Lap B", never one lap on its own.
- Time deltas are an effect, not a cause. Always explain WHY one lap is faster: the input technique, the corner approach, the racing line, the decision-making — not just that it is faster.
- Driver inputs (throttle, brake, steering) and the car's response are your primary evidence. Pace, gear, and RPM are supporting context.
- Be specific. Cite distances in meters, percentages for inputs, and segment names where available.
- Use racing engineering vocabulary: trail braking, throttle modulation, apex line, mid-corner balance, exit drive, brake release, steering smoothness, lift-off oversteer, etc.
- Identify "where time is being gained or lost" by tying delta changes to specific input differences.
- Coaching is for the SLOWER lap unless the prompt says otherwise. Tell that driver what to change and why.
- Never invent differences. If two laps are essentially identical for an input in a section, say so plainly.

Units: ${units}.
Refer to the laps as "Lap A" and "Lap B".`;
}

/**
 * Standard compare context block — track, both lap headers, and the final delta.
 * Both compare flows render this so the model has identical framing.
 */
export function compareLapHeader(
  trackName: string,
  carA: string,
  carB: string,
  lapA: { lapNumber: number; lapTime: number; isValid: boolean },
  lapB: { lapNumber: number; lapTime: number; isValid: boolean },
  finalDelta: number,
): string {
  const sign = finalDelta >= 0 ? "+" : "";
  return `--- LAPS UNDER COMPARISON ---
Track: ${trackName}
Lap A: ${carA} — Lap #${lapA.lapNumber} — ${lapA.lapTime.toFixed(3)}s${lapA.isValid ? "" : " (INVALID)"}
Lap B: ${carB} — Lap #${lapB.lapNumber} — ${lapB.lapTime.toFixed(3)}s${lapB.isValid ? "" : " (INVALID)"}
Final time delta (A − B): ${sign}${finalDelta.toFixed(3)}s  (positive = Lap A is slower)`;
}
