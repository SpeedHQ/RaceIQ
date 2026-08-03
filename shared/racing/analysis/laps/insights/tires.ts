import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryModel } from "../../../../games/types";
import type { LapInsight } from "./types";
import { groupEvents, midFrame } from "./types";
import { allWheelStates } from "../physics/vehicle";

type TireTemperaturePacketUnit = TelemetryModel["tireTemperature"]["packetUnit"];

export function detectTireOverheat(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "TireTempFL",
    FR: "TireTempFR",
    RL: "TireTempRL",
    RR: "TireTempRR",
  } as const;

  // Compare in the packet unit declared by the adapter.
  const fahrenheit = packetUnit === "fahrenheit";
  const warnTemp = fahrenheit ? 250 : 110;
  const critTemp = fahrenheit ? 300 : 130;
  const unit = fahrenheit ? "°F" : "°C";

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > warnTemp);
    const events = groupEvents(flags, 10, 30);
    if (events.length > 0) {
      const peak = Math.max(...telemetry.map((p) => p[fields[w]]));
      insights.push({
        id: `tire-overheat-${w}`,
        category: "tires",
        severity: peak > critTemp ? "critical" : "warning",
        label: "Tire Overheat",
        detail: `${w} exceeded ${warnTemp}${unit} (peak ${peak.toFixed(0)}${unit})`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

export function detectLockups(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const flags = telemetry.map((p) => {
      const ws = allWheelStates(p);
      return ws[w.toLowerCase() as "fl" | "fr" | "rl" | "rr"].state === "lockup";
    });
    const events = groupEvents(flags, 5, 15);
    if (events.length > 0) {
      insights.push({
        id: `tire-lockup-${w}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheel Lockup",
        detail: `${w} locked ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

export function detectWheelspin(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const flags = telemetry.map((p) => {
      const ws = allWheelStates(p);
      return ws[w.toLowerCase() as "fl" | "fr" | "rl" | "rr"].state === "spin";
    });
    const events = groupEvents(flags, 5, 15);
    if (events.length > 0) {
      insights.push({
        id: `tire-spin-${w}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheelspin",
        detail: `${w} spun ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

export function detectWearImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  const last = telemetry[telemetry.length - 1];
  if (!last) return null;
  const wears = [last.TireWearFL, last.TireWearFR, last.TireWearRL, last.TireWearRR];
  if (wears.some((w) => w < 0)) return null; // -1 = wear not reported (short FM packet)
  const labels = ["FL", "FR", "RL", "RR"];
  const maxW = Math.max(...wears);
  const minW = Math.min(...wears);
  const delta = maxW - minW;
  if (delta > 0.15) {
    const maxLabel = labels[wears.indexOf(maxW)];
    const minLabel = labels[wears.indexOf(minW)];
    return {
      id: "tire-wear-imbalance",
      category: "tires",
      severity: delta > 0.3 ? "critical" : "warning",
      label: "Wear Imbalance",
      detail: `${maxLabel} most worn, ${minLabel} least (${(delta * 100).toFixed(0)}% spread)`,
      frameIndices: [telemetry.length - 1],
    };
  }
  return null;
}

export function detectTireTempSplit(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
): LapInsight | null {
  // Persistent front/rear temperature split points at setup balance:
  // hot fronts = understeer-prone, hot rears = oversteer/traction-limited.
  let front = 0;
  let rear = 0;
  let n = 0;
  for (const p of telemetry) {
    if (p.Speed * 2.23694 < 15) continue;
    front += (p.TireTempFL + p.TireTempFR) / 2;
    rear += (p.TireTempRL + p.TireTempRR) / 2;
    n++;
  }
  if (n < 100) return null;
  front /= n;
  rear /= n;
  if (front <= 0 || rear <= 0) return null; // temps not reported

  const fahrenheit = packetUnit === "fahrenheit";
  const warn = fahrenheit ? 25 : 12;
  const crit = fahrenheit ? 45 : 22;
  const unit = fahrenheit ? "°F" : "°C";
  const delta = front - rear;
  if (Math.abs(delta) < warn) return null;

  const hotEnd = delta > 0 ? "front" : "rear";
  const hint = delta > 0 ? "understeer-prone — consider softer front or more front downforce" : "oversteer/traction-limited — consider softer rear or less rear camber";
  return {
    id: "tire-temp-split",
    category: "tires",
    severity: Math.abs(delta) > crit ? "warning" : "info",
    label: "Front/Rear Temp Split",
    detail: `${hotEnd} axle ${Math.abs(delta).toFixed(0)}${unit} hotter on average — ${hint}`,
    frameIndices: [Math.round(telemetry.length / 2)],
  };
}

export function detectInnerOuterTempSpread(telemetry: TelemetryPacket[]): LapInsight[] {
  // ACC-only: inner-vs-outer tread temperature spread indicates camber/pressure
  // problems. Sustained inner-hot = too much camber; outer-hot = not enough.
  const labels = ["FL", "FR", "RL", "RR"] as const;
  const sums = [0, 0, 0, 0];
  let n = 0;
  for (const p of telemetry) {
    const acc = p.acc;
    if (!acc || p.Speed * 2.23694 < 15) continue;
    for (let t = 0; t < 4; t++) {
      sums[t] += acc.tireInnerTemp[t] - acc.tireOuterTemp[t];
    }
    n++;
  }
  if (n < 100) return [];

  const insights: LapInsight[] = [];
  for (let t = 0; t < 4; t++) {
    const delta = sums[t] / n; // °C, + = inner hotter
    if (Math.abs(delta) < 8) continue;
    const hint = delta > 0 ? "inner edge running hot — reduce negative camber or raise pressure" : "outer edge running hot — add negative camber";
    insights.push({
      id: `tire-edge-temp-${labels[t]}`,
      category: "tires",
      severity: Math.abs(delta) > 15 ? "warning" : "info",
      label: "Tire Edge Temp Spread",
      detail: `${labels[t]} ${Math.abs(delta).toFixed(0)}°C ${delta > 0 ? "inner" : "outer"}-hot on average — ${hint}`,
      frameIndices: [Math.round(telemetry.length / 2)],
    });
  }
  return insights;
}

