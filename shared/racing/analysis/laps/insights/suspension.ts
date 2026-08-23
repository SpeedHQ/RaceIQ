import type { SemanticLapFrame } from "../semantic-frame";
import { groupEvents, midFrame } from "./types";
import type { LapInsight } from "./types";
const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function detectSuspensionOverload(telemetry: SemanticLapFrame[]): LapInsight[] {
  const wheels = [
    ["FL", 0],
    ["FR", 1],
    ["RL", 2],
    ["RR", 3],
  ] as const;
  const insights: LapInsight[] = [];
  for (const [wheel, index] of wheels) {
    const flags = telemetry.map((frame) => {
      const travel = frame.normalizedSuspensionTravel[index];
      return finite(travel) && travel > 0.95;
    });
    const events = groupEvents(flags, 3);
    if (events.length > 0)
      insights.push({
        id: `susp-overload-${wheel}`,
        category: "suspension",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Suspension Overload",
        detail: `${wheel} bottomed out ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
  }
  return insights;
}

export function detectSuspensionImbalance(telemetry: SemanticLapFrame[]): LapInsight | null {
  let totalDelta = 0;
  let count = 0;
  for (const frame of telemetry) {
    const [fl, fr, rl, rr] = frame.normalizedSuspensionTravel;
    if (!finite(fl) || !finite(fr) || !finite(rl) || !finite(rr)) continue;
    totalDelta += (fl + rl - fr - rr) / 2;
    count++;
  }
  if (count === 0) return null;
  const avgDelta = totalDelta / count;
  if (Math.abs(avgDelta) <= 0.15) return null;
  const side = avgDelta > 0 ? "left" : "right";
  return {
    id: "susp-imbalance",
    category: "suspension",
    severity: Math.abs(avgDelta) > 0.25 ? "critical" : "warning",
    label: "Suspension Imbalance",
    detail: `${side} side compressed ${(Math.abs(avgDelta) * 100).toFixed(0)}% more on average — check corner weights/ride height (or a one-direction track)`,
    frameIndices: [Math.round(telemetry.length / 2)],
  };
}
