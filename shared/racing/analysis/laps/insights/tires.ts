import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryModel } from "../../../../games/types";
import type { AllWheelStates } from "../physics/vehicle";
import type { LapInsight } from "./types";
import { groupEvents, midFrame } from "./types";

type TireTemperaturePacketUnit = TelemetryModel["tireTemperature"]["packetUnit"];
type Wheel = "FL" | "FR" | "RL" | "RR";
type TireTemperatureLayer = "primary" | "core";
type TireTemperatureFields = Record<Wheel, keyof TelemetryPacket>;

const WHEELS: readonly Wheel[] = ["FL", "FR", "RL", "RR"];
const PRIMARY_TEMPERATURE_FIELDS: TireTemperatureFields = {
  FL: "TireTempFL",
  FR: "TireTempFR",
  RL: "TireTempRL",
  RR: "TireTempRR",
};
const CORE_TEMPERATURE_FIELDS: TireTemperatureFields = {
  FL: "TireCarcassTempFL",
  FR: "TireCarcassTempFR",
  RL: "TireCarcassTempRL",
  RR: "TireCarcassTempRR",
};

function temperatureFields(layer: TireTemperatureLayer): TireTemperatureFields {
  return layer === "core" ? CORE_TEMPERATURE_FIELDS : PRIMARY_TEMPERATURE_FIELDS;
}

function temperatureValue(packet: TelemetryPacket, field: keyof TelemetryPacket): number | undefined {
  const value = packet[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function temperatureScale(packetUnit: TireTemperaturePacketUnit): { factor: number; unit: string } {
  return packetUnit === "fahrenheit" ? { factor: 1.8, unit: "°F" } : { factor: 1, unit: "°C" };
}

export function detectTireOverheat(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  layer: TireTemperatureLayer = "primary",
  identity: "primary" | "separate-core" = "primary",
): LapInsight[] {
  const fields = temperatureFields(layer);
  const fahrenheit = packetUnit === "fahrenheit";
  const warnTemp = fahrenheit ? 250 : 110;
  const critTemp = fahrenheit ? 300 : 130;
  const unit = fahrenheit ? "°F" : "°C";
  const core = identity === "separate-core";
  const insights: LapInsight[] = [];

  for (const wheel of WHEELS) {
    const flags = new Array<boolean>(telemetry.length);
    let peak = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < telemetry.length; i++) {
      const value = temperatureValue(telemetry[i], fields[wheel]);
      flags[i] = value !== undefined && value > warnTemp;
      if (value !== undefined && value > peak) peak = value;
    }
    const events = groupEvents(flags, 10, 30);
    if (events.length === 0) continue;
    insights.push({
      id: `${core ? "tire-core-overheat" : "tire-overheat"}-${wheel}`,
      category: "tires",
      severity: peak > critTemp ? "critical" : "warning",
      label: core ? "Tire Core Overheat" : "Tire Overheat",
      detail: `${wheel}${core ? " core" : ""} exceeded ${warnTemp}${unit} (peak ${peak.toFixed(0)}${unit})`,
      frameIndices: midFrame(events),
    });
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

export function detectTireTempSplit(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  layer: TireTemperatureLayer = "primary",
): LapInsight | null {
  // Persistent front/rear temperature split points at setup balance:
  // hot fronts = understeer-prone, hot rears = oversteer/traction-limited.
  const fields = temperatureFields(layer);
  let front = 0;
  let rear = 0;
  let samples = 0;
  for (const packet of telemetry) {
    if (packet.Speed * 2.23694 < 15) continue;
    const fl = temperatureValue(packet, fields.FL);
    const fr = temperatureValue(packet, fields.FR);
    const rl = temperatureValue(packet, fields.RL);
    const rr = temperatureValue(packet, fields.RR);
    if (fl === undefined || fr === undefined || rl === undefined || rr === undefined) continue;
    front += (fl + fr) / 2;
    rear += (rl + rr) / 2;
    samples++;
  }
  if (samples < 100) return null;
  front /= samples;
  rear /= samples;

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

const SURFACE_PROFILE_FIELDS = {
  FL: ["TireSurfaceTempInnerFL", "TireSurfaceTempMiddleFL", "TireSurfaceTempOuterFL"],
  FR: ["TireSurfaceTempInnerFR", "TireSurfaceTempMiddleFR", "TireSurfaceTempOuterFR"],
  RL: ["TireSurfaceTempInnerRL", "TireSurfaceTempMiddleRL", "TireSurfaceTempOuterRL"],
  RR: ["TireSurfaceTempInnerRR", "TireSurfaceTempMiddleRR", "TireSurfaceTempOuterRR"],
} as const satisfies Record<Wheel, readonly [keyof TelemetryPacket, keyof TelemetryPacket, keyof TelemetryPacket]>;

/** Diagnose persistent tread-profile gradients from continuous inner/middle/outer surface temperatures. */
export function detectTireSurfaceProfile(telemetry: TelemetryPacket[], packetUnit: TireTemperaturePacketUnit): LapInsight[] {
  const { factor, unit } = temperatureScale(packetUnit);
  const edgeWarn = 10 * factor;
  const edgeCritical = 20 * factor;
  const shapeWarn = 8 * factor;
  const shapeCritical = 15 * factor;
  const insights: LapInsight[] = [];

  for (const wheel of WHEELS) {
    const [innerField, middleField, outerField] = SURFACE_PROFILE_FIELDS[wheel];
    let innerTotal = 0;
    let middleTotal = 0;
    let outerTotal = 0;
    let samples = 0;
    let peakIndex = 0;
    let peakDeviation = 0;

    for (let i = 0; i < telemetry.length; i++) {
      const packet = telemetry[i];
      if (packet.Speed * 2.23694 < 15) continue;
      const inner = temperatureValue(packet, innerField);
      const middle = temperatureValue(packet, middleField);
      const outer = temperatureValue(packet, outerField);
      if (inner === undefined || middle === undefined || outer === undefined) continue;
      innerTotal += inner;
      middleTotal += middle;
      outerTotal += outer;
      samples++;
      const deviation = Math.max(Math.abs(inner - outer), Math.abs(middle - (inner + outer) / 2));
      if (deviation > peakDeviation) {
        peakDeviation = deviation;
        peakIndex = i;
      }
    }
    if (samples < 100) continue;

    const inner = innerTotal / samples;
    const middle = middleTotal / samples;
    const outer = outerTotal / samples;
    const edgeDelta = inner - outer;
    if (Math.abs(edgeDelta) >= edgeWarn) {
      insights.push({
        id: `tire-surface-edge-imbalance-${wheel}`,
        category: "tires",
        severity: Math.abs(edgeDelta) >= edgeCritical ? "critical" : "warning",
        label: "Tire Surface Edge Imbalance",
        detail: `${wheel} ${edgeDelta > 0 ? "inner" : "outer"} edge averaged ${Math.abs(edgeDelta).toFixed(1)}${unit} hotter — check camber`,
        frameIndices: [peakIndex],
      });
    }

    const shapeDelta = middle - (inner + outer) / 2;
    if (Math.abs(shapeDelta) >= shapeWarn) {
      insights.push({
        id: `tire-surface-pressure-shape-${wheel}`,
        category: "tires",
        severity: Math.abs(shapeDelta) >= shapeCritical ? "critical" : "warning",
        label: "Tire Surface Pressure Shape",
        detail: `${wheel} ${shapeDelta > 0 ? "center" : "shoulders"} averaged ${Math.abs(shapeDelta).toFixed(1)}${unit} hotter — check ${shapeDelta > 0 ? "overinflation" : "underinflation"}`,
        frameIndices: [peakIndex],
      });
    }
  }
  return insights;
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
