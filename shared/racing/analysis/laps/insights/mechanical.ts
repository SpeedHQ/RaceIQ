import type { SemanticLapFrame } from "../semantic-frame";
import type { TelemetryModel } from "../../../../games/types";
import type { LapInsight } from "./types";
import { groupEvents, midFrame } from "./types";

type FuelPacketUnit = TelemetryModel["fuel"]["packetUnit"];
const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export function detectFuelConsumption(telemetry: SemanticLapFrame[], packetUnit: FuelPacketUnit): LapInsight | null {
  if (telemetry.length < 2) return null;
  const first = telemetry[0];
  const last = telemetry[telemetry.length - 1];
  if (!first || !last) return null;
  const startFuel = first.fuel;
  const endFuel = last.fuel;
  if (!finite(startFuel) || !finite(endFuel)) return null;
  const used = startFuel - endFuel;
  if (used <= 0) return null;
  const lapsRemaining = endFuel > 0 ? endFuel / used : Number.POSITIVE_INFINITY;
  const usedLabel = packetUnit === "litre" ? `${used.toFixed(2)} L` : `${(used * 100).toFixed(1)}%`;
  return {
    id: "mech-fuel",
    category: "mechanical",
    severity: lapsRemaining < 3 ? "critical" : lapsRemaining < 5 ? "warning" : "info",
    label: "Fuel",
    detail: `Used ${usedLabel} — ~${lapsRemaining === Number.POSITIVE_INFINITY ? "∞" : lapsRemaining.toFixed(1)} laps remaining`,
    frameIndices: [telemetry.length - 1],
  };
}

export function detectPeakPower(telemetry: SemanticLapFrame[]): LapInsight | null {
  let peakIdx = -1;
  let peakPower = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < telemetry.length; i++) {
    const frame = telemetry[i];
    if (!frame) continue;
    const power = frame.power;
    if (finite(power) && power > peakPower) {
      peakPower = power;
      peakIdx = i;
    }
  }
  if (peakIdx < 0 || peakPower <= 0) return null;
  const frame = telemetry[peakIdx];
  if (!frame || !finite(frame.engineRpm) || !finite(frame.gear)) return null;
  return {
    id: "mech-peak-power",
    category: "mechanical",
    severity: "info",
    label: "Peak Power",
    detail: `${(peakPower / 745.7).toFixed(0)} hp @ ${frame.engineRpm.toFixed(0)} RPM (gear ${frame.gear})`,
    frameIndices: [peakIdx],
  };
}

export function detectBoostAnomaly(telemetry: SemanticLapFrame[]): LapInsight | null {
  const flags = new Array<boolean>(telemetry.length).fill(false);
  let rollingPeak = Number.NEGATIVE_INFINITY;
  let hasEvidence = false;
  for (let i = 0; i < telemetry.length; i++) {
    const frame = telemetry[i];
    if (!frame || !finite(frame.boost) || !finite(frame.throttleInput)) continue;
    hasEvidence = true;
    rollingPeak = Math.max(rollingPeak, frame.boost);
    if (i >= 60) {
      rollingPeak = Number.NEGATIVE_INFINITY;
      for (let j = i - 59; j <= i; j++) {
        const boost = telemetry[j]?.boost;
        if (finite(boost)) rollingPeak = Math.max(rollingPeak, boost);
      }
    }
    flags[i] = frame.throttleInput > 240 && rollingPeak > 0 && frame.boost < rollingPeak * 0.5;
  }
  if (!hasEvidence) return null;
  const events = groupEvents(flags, 5);
  if (events.length === 0) return null;
  return {
    id: "mech-boost-anomaly",
    category: "mechanical",
    severity: events.length >= 3 ? "critical" : "warning",
    label: "Boost Drop",
    detail: `${events.length} unexpected boost drop${events.length > 1 ? "s" : ""} at full throttle`,
    frameIndices: midFrame(events),
  };
}
