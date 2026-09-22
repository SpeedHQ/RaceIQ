import type { TelemetryPacket } from "../../../../telemetry/types";
import { eventDurations, groupEvents, midFrame } from "./types";
import type { LapInsight } from "./types";

export function detectSuspensionOverload(telemetry: TelemetryPacket[]): LapInsight[] {
  const dt = eventDurations(telemetry);
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "NormSuspensionTravelFL",
    FR: "NormSuspensionTravelFR",
    RL: "NormSuspensionTravelRL",
    RR: "NormSuspensionTravelRR",
  } as const;

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => Number.isFinite(p[fields[w]]) && p[fields[w]] > 0.95 && p.Speed > 7);
    const events = groupEvents(flags, dt, 0.05);
    if (events.length > 0) {
      insights.push({
        id: `susp-overload-${w}`,
        category: "suspension",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Suspension Overload",
        detail: `${w} reached more than 95% of suspension travel in ${events.length} zone${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

export function detectSuspensionImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  const dt = eventDurations(telemetry);
  let totalDelta = 0;
  let seconds = 0;
  for (let i = 0; i < telemetry.length; i++) {
    const p = telemetry[i];
    if (!(dt[i] > 0) || !(p.Speed > 7) || !(Math.abs(p.AccelerationX) < 1) || !(Math.abs(p.Steer) < 15) || !(p.Brake < 25)) continue;
    const left = (p.NormSuspensionTravelFL + p.NormSuspensionTravelRL) / 2;
    const right = (p.NormSuspensionTravelFR + p.NormSuspensionTravelRR) / 2;
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    totalDelta += (left - right) * dt[i];
    seconds += dt[i];
  }
  if (seconds < 2) return null;
  const avgDelta = totalDelta / seconds;
  if (Math.abs(avgDelta) > 0.15) {
    const side = avgDelta > 0 ? "left" : "right";
    return {
      id: "susp-imbalance",
      category: "suspension",
      severity: Math.abs(avgDelta) > 0.25 ? "critical" : "warning",
      label: "Suspension Imbalance",
      detail: `${side} side compressed ${(Math.abs(avgDelta) * 100).toFixed(0)}% more during low-lateral-load running; road banking and setup can both contribute`,
      frameIndices: [Math.round(telemetry.length / 2)],
    };
  }
  return null;
}

