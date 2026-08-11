import type { TelemetryPacket } from "../../../../telemetry/types";
import { groupEvents, midFrame } from "./types";
import type { LapInsight } from "./types";

export function detectSuspensionOverload(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "NormSuspensionTravelFL",
    FR: "NormSuspensionTravelFR",
    RL: "NormSuspensionTravelRL",
    RR: "NormSuspensionTravelRR",
  } as const;

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > 0.95);
    const events = groupEvents(flags, 3);
    if (events.length > 0) {
      insights.push({
        id: `susp-overload-${w}`,
        category: "suspension",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Suspension Overload",
        detail: `${w} bottomed out ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

export function detectSuspensionImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  let totalDelta = 0;
  for (const p of telemetry) {
    const left = (p.NormSuspensionTravelFL + p.NormSuspensionTravelRL) / 2;
    const right = (p.NormSuspensionTravelFR + p.NormSuspensionTravelRR) / 2;
    totalDelta += left - right;
  }
  const avgDelta = totalDelta / telemetry.length;
  if (Math.abs(avgDelta) > 0.15) {
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
  return null;
}

