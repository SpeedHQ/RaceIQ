import type { TelemetryPacket } from "../../telemetry/types";
import type { TelemetryModel } from "../../games/types";
import type { LapInsight } from "./types";
import { groupEvents, midFrame } from "./types";

type FuelPacketUnit = TelemetryModel["fuel"]["packetUnit"];

export function detectFuelConsumption(telemetry: TelemetryPacket[], packetUnit: FuelPacketUnit): LapInsight | null {
  if (telemetry.length < 2) return null;
  const startFuel = telemetry[0].Fuel;
  const endFuel = telemetry[telemetry.length - 1].Fuel;
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

export function detectPeakPower(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length === 0) return null;
  let peakIdx = 0;
  let peakVal = 0;
  for (let i = 0; i < telemetry.length; i++) {
    if (telemetry[i].Power > peakVal) {
      peakVal = telemetry[i].Power;
      peakIdx = i;
    }
  }
  if (peakVal === 0) return null;
  const pkt = telemetry[peakIdx];
  const hp = peakVal / 745.7;
  return {
    id: "mech-peak-power",
    category: "mechanical",
    severity: "info",
    label: "Peak Power",
    detail: `${hp.toFixed(0)} hp @ ${pkt.CurrentEngineRpm.toFixed(0)} RPM (gear ${pkt.Gear})`,
    frameIndices: [peakIdx],
  };
}

export function detectBoostAnomaly(telemetry: TelemetryPacket[]): LapInsight | null {
  const maxBoost = Math.max(...telemetry.map((p) => p.Boost));
  if (maxBoost <= 0) return null;

  const flags: boolean[] = new Array(telemetry.length).fill(false);
  let rollingPeak = 0;
  for (let i = 0; i < telemetry.length; i++) {
    rollingPeak = Math.max(rollingPeak, telemetry[i].Boost);
    if (i >= 60) {
      rollingPeak = 0;
      for (let j = i - 59; j <= i; j++) {
        rollingPeak = Math.max(rollingPeak, telemetry[j].Boost);
      }
    }
    if (telemetry[i].Accel > 240 && rollingPeak > 0 && telemetry[i].Boost < rollingPeak * 0.5) {
      flags[i] = true;
    }
  }
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

