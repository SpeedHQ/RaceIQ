import type { SemanticLapFrame } from "../semantic-frame";
import type { TelemetryModel } from "../../../../games/types";
import type { LapInsight } from "./types";
import { groupEvents, midFrame } from "./types";
import { wheelStatesFromSignals } from "../physics/vehicle";

type TireTemperaturePacketUnit = TelemetryModel["tireTemperature"]["packetUnit"];
const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function detectTireOverheat(telemetry: SemanticLapFrame[], packetUnit: TireTemperaturePacketUnit): LapInsight[] {
  const wheels = [
    ["FL", 0],
    ["FR", 1],
    ["RL", 2],
    ["RR", 3],
  ] as const;
  const fahrenheit = packetUnit === "fahrenheit";
  const warnTemp = fahrenheit ? 250 : 110;
  const critTemp = fahrenheit ? 300 : 130;
  const unit = fahrenheit ? "°F" : "°C";
  const insights: LapInsight[] = [];
  for (const [wheel, index] of wheels) {
    let peak = Number.NEGATIVE_INFINITY;
    const flags = telemetry.map((frame) => {
      const temperature = frame.tireTemperature[index];
      if (!finite(temperature)) return false;
      peak = Math.max(peak, temperature);
      return temperature > warnTemp;
    });
    const events = groupEvents(flags, 10, 30);
    if (events.length > 0)
      insights.push({
        id: `tire-overheat-${wheel}`,
        category: "tires",
        severity: peak > critTemp ? "critical" : "warning",
        label: "Tire Overheat",
        detail: `${wheel} exceeded ${warnTemp}${unit} (peak ${peak.toFixed(0)}${unit})`,
        frameIndices: midFrame(events),
      });
  }
  return insights;
}

export function detectLockups(telemetry: SemanticLapFrame[]): LapInsight[] {
  const wheels = [
    ["FL", "fl"],
    ["FR", "fr"],
    ["RL", "rl"],
    ["RR", "rr"],
  ] as const;
  const insights: LapInsight[] = [];
  for (const [wheel, key] of wheels) {
    const flags = telemetry.map((frame) => wheelStatesFromSignals(frame.speedMps, frame.steeringInput, frame.wheelRotationRadPerSec)?.[key].state === "lockup");
    const events = groupEvents(flags, 5, 15);
    if (events.length > 0)
      insights.push({
        id: `tire-lockup-${wheel}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheel Lockup",
        detail: `${wheel} locked ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
  }
  return insights;
}

export function detectWheelspin(telemetry: SemanticLapFrame[]): LapInsight[] {
  const wheels = [
    ["FL", "fl"],
    ["FR", "fr"],
    ["RL", "rl"],
    ["RR", "rr"],
  ] as const;
  const insights: LapInsight[] = [];
  for (const [wheel, key] of wheels) {
    const flags = telemetry.map((frame) => wheelStatesFromSignals(frame.speedMps, frame.steeringInput, frame.wheelRotationRadPerSec)?.[key].state === "spin");
    const events = groupEvents(flags, 5, 15);
    if (events.length > 0)
      insights.push({
        id: `tire-spin-${wheel}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheelspin",
        detail: `${wheel} spun ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
  }
  return insights;
}

export function detectWearImbalance(telemetry: SemanticLapFrame[]): LapInsight | null {
  const last = telemetry[telemetry.length - 1];
  if (!last) return null;
  const wears = last.tireWear;
  const [fl, fr, rl, rr] = wears;
  if (!finite(fl) || !finite(fr) || !finite(rl) || !finite(rr) || fl < 0 || fr < 0 || rl < 0 || rr < 0) return null;
  const maxW = Math.max(fl, fr, rl, rr);
  const minW = Math.min(fl, fr, rl, rr);
  const delta = maxW - minW;
  if (delta <= 0.15) return null;
  const labels = ["FL", "FR", "RL", "RR"] as const;
  const maxIndex = fl === maxW ? 0 : fr === maxW ? 1 : rl === maxW ? 2 : 3;
  const minIndex = fl === minW ? 0 : fr === minW ? 1 : rl === minW ? 2 : 3;
  return {
    id: "tire-wear-imbalance",
    category: "tires",
    severity: delta > 0.3 ? "critical" : "warning",
    label: "Wear Imbalance",
    detail: `${labels[maxIndex]} most worn, ${labels[minIndex]} least (${(delta * 100).toFixed(0)}% spread)`,
    frameIndices: [telemetry.length - 1],
  };
}

export function detectTireTempSplit(telemetry: SemanticLapFrame[], packetUnit: TireTemperaturePacketUnit): LapInsight | null {
  let front = 0;
  let rear = 0;
  let count = 0;
  for (const frame of telemetry) {
    const temperatures = frame.tireTemperature;
    if (!finite(frame.speedMps) || frame.speedMps * 2.23694 < 15 || !finite(temperatures[0]) || !finite(temperatures[1]) || !finite(temperatures[2]) || !finite(temperatures[3])) continue;
    front += (temperatures[0] + temperatures[1]) / 2;
    rear += (temperatures[2] + temperatures[3]) / 2;
    count++;
  }
  if (count < 100) return null;
  front /= count;
  rear /= count;
  if (front <= 0 || rear <= 0) return null;
  const fahrenheit = packetUnit === "fahrenheit";
  const warn = fahrenheit ? 25 : 12;
  const crit = fahrenheit ? 45 : 22;
  const delta = front - rear;
  if (Math.abs(delta) < warn) return null;
  const hotEnd = delta > 0 ? "front" : "rear";
  const hint = delta > 0 ? "understeer-prone — consider softer front or more front downforce" : "oversteer/traction-limited — consider softer rear or less rear camber";
  return {
    id: "tire-temp-split",
    category: "tires",
    severity: Math.abs(delta) > crit ? "warning" : "info",
    label: "Front/Rear Temp Split",
    detail: `${hotEnd} axle ${Math.abs(delta).toFixed(0)}${fahrenheit ? "°F" : "°C"} hotter on average — ${hint}`,
    frameIndices: [Math.round(telemetry.length / 2)],
  };
}

export function detectInnerOuterTempSpread(_: SemanticLapFrame[]): LapInsight[] {
  return [];
}
