import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryModel } from "../../../../games/types";
import type { AllWheelStates } from "../physics/vehicle";
import type { LapInsight } from "./types";
import { groupEvents, midFrame } from "./types";

type TireTemperaturePacketUnit = TelemetryModel["tireTemperature"]["packetUnit"];

export function detectTireOverheat(telemetry: TelemetryPacket[], packetUnit: TireTemperaturePacketUnit): LapInsight[] {
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

export function detectLockups(wheelStates: readonly AllWheelStates[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const key = w.toLowerCase() as "fl" | "fr" | "rl" | "rr";
    const flags = wheelStates.map((ws) => ws[key].state === "lockup");
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

export function detectWheelspin(wheelStates: readonly AllWheelStates[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const key = w.toLowerCase() as "fl" | "fr" | "rl" | "rr";
    const flags = wheelStates.map((ws) => ws[key].state === "spin");
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

export function detectTireTempSplit(telemetry: TelemetryPacket[], packetUnit: TireTemperaturePacketUnit): LapInsight | null {
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

export function detectTirePressureImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  let frontDelta = 0;
  let rearDelta = 0;
  let samples = 0;
  let peakIdx = 0;
  let peakDelta = 0;

  for (let i = 0; i < telemetry.length; i++) {
    const p = telemetry[i];
    const fl = p.TirePressureFrontLeft;
    const fr = p.TirePressureFrontRight;
    const rl = p.TirePressureRearLeft;
    const rr = p.TirePressureRearRight;
    if (
      p.Speed * 2.23694 < 15 ||
      fl == null ||
      fr == null ||
      rl == null ||
      rr == null ||
      !Number.isFinite(fl) ||
      !Number.isFinite(fr) ||
      !Number.isFinite(rl) ||
      !Number.isFinite(rr) ||
      fl <= 0 ||
      fr <= 0 ||
      rl <= 0 ||
      rr <= 0
    ) {
      continue;
    }

    const front = fl - fr;
    const rear = rl - rr;
    frontDelta += front;
    rearDelta += rear;
    samples++;
    if (Math.max(Math.abs(front), Math.abs(rear)) > peakDelta) {
      peakDelta = Math.max(Math.abs(front), Math.abs(rear));
      peakIdx = i;
    }
  }

  if (samples < 100) return null;
  const frontAvg = frontDelta / samples;
  const rearAvg = rearDelta / samples;
  const axle = Math.abs(frontAvg) >= Math.abs(rearAvg) ? "front" : "rear";
  const delta = axle === "front" ? frontAvg : rearAvg;
  if (Math.abs(delta) < 1.5) return null;

  return {
    id: "tire-pressure-imbalance",
    category: "tires",
    severity: Math.abs(delta) >= 3 ? "critical" : "warning",
    label: "Tire Pressure Imbalance",
    detail: `${axle} ${delta > 0 ? "left" : "right"} tire averaged ${Math.abs(delta).toFixed(1)} psi higher — check cold pressures or tire damage`,
    frameIndices: [peakIdx],
  };
}
