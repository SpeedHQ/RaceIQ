import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryModel } from "../../../../games/types";
import type { AllWheelStates } from "../physics/vehicle";
import type { LapInsight } from "./types";
import { eventDurations, eventSeconds, groupEvents, midFrame } from "./types";

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

function celsius(value: number, packetUnit: TireTemperaturePacketUnit): number {
  return packetUnit === "fahrenheit" ? (value - 32) / 1.8 : value;
}

function activeTireSample(packet: TelemetryPacket): boolean {
  return Number.isFinite(packet.Speed) && packet.Speed * 2.23694 >= 15 &&
    packet.IsRaceOn !== 0 &&
    (!packet.acc?.pitStatus || packet.acc.pitStatus === "out") &&
    !packet.f1?.pitLimiterStatus && !packet.f1?.pitLaneTimerActive;
}

export function detectTireOverheat(
  telemetry: TelemetryPacket[],
  packetUnit: TireTemperaturePacketUnit,
  layer: TireTemperatureLayer = "primary",
  identity: "primary" | "separate-core" = "primary",
): LapInsight[] {
  const fields = temperatureFields(layer);
  const dt = eventDurations(telemetry);
  const { factor, unit } = temperatureScale(packetUnit);
  const warnTemp = 110;
  const critTemp = 130;
  const core = identity === "separate-core";
  const insights: LapInsight[] = [];

  for (const wheel of WHEELS) {
    const flags = new Array<boolean>(telemetry.length);
    const criticalFlags = new Array<boolean>(telemetry.length);
    for (let i = 0; i < telemetry.length; i++) {
      const value = temperatureValue(telemetry[i], fields[wheel]);
      const temp = value === undefined ? undefined : celsius(value, packetUnit);
      flags[i] = activeTireSample(telemetry[i]) && temp !== undefined && temp > warnTemp;
      criticalFlags[i] = flags[i] && temp !== undefined && temp > critTemp;
    }
    const events = groupEvents(flags, dt, 10 / 60, 0.5);
    if (events.length === 0) continue;
    let peak = Number.NEGATIVE_INFINITY;
    for (const [start, end] of events) {
      for (let i = start; i <= end; i++) {
        if (flags[i]) peak = Math.max(peak, telemetry[i][fields[wheel]] as number);
      }
    }
    const critical = groupEvents(criticalFlags, dt, 10 / 60, 0.5).length > 0;
    insights.push({
      id: `${core ? "tire-core-overheat" : "tire-overheat"}-${wheel}`,
      category: "tires",
      severity: critical ? "critical" : "warning",
      label: core ? "Tire Core Overheat" : "Tire Overheat",
      detail: `${wheel}${core ? " core" : ""} exceeded ${warnTemp * factor + (packetUnit === "fahrenheit" ? 32 : 0)}${unit} (peak ${peak.toFixed(0)}${unit})`,
      frameIndices: midFrame(events),
    });
  }
  return insights;
}

export function detectLockups(wheelStates: readonly AllWheelStates[], dt: readonly number[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const key = w.toLowerCase() as "fl" | "fr" | "rl" | "rr";
    const flags = wheelStates.map((ws) => ws[key].state === "lockup");
    const events = groupEvents(flags, dt, 5 / 60, 0.25);
    if (events.length > 0) {
      insights.push({
        id: `tire-lockup-${w}`,
        category: "tires",
        severity: events.reduce((seconds, [start, end]) => seconds + eventSeconds(dt, start, end, flags), 0) >= 1 ? "critical" : "warning",
        label: "Wheel Lockup",
        detail: `${w} locked ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

export function detectWheelspin(wheelStates: readonly AllWheelStates[], dt: readonly number[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const key = w.toLowerCase() as "fl" | "fr" | "rl" | "rr";
    const flags = wheelStates.map((ws) => ws[key].state === "spin");
    const events = groupEvents(flags, dt, 5 / 60, 0.25);
    if (events.length > 0) {
      insights.push({
        id: `tire-spin-${w}`,
        category: "tires",
        severity: events.reduce((seconds, [start, end]) => seconds + eventSeconds(dt, start, end, flags), 0) >= 1 ? "critical" : "warning",
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
  const fields = temperatureFields(layer);
  const dt = eventDurations(telemetry);
  let front = 0;
  let rear = 0;
  let seconds = 0;
  let evidenceIndex = 0;
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    if (!(dt[i] > 0) || !activeTireSample(packet)) continue;
    const fl = temperatureValue(packet, fields.FL);
    const fr = temperatureValue(packet, fields.FR);
    const rl = temperatureValue(packet, fields.RL);
    const rr = temperatureValue(packet, fields.RR);
    if (fl === undefined || fr === undefined || rl === undefined || rr === undefined) continue;
    front += (celsius(fl, packetUnit) + celsius(fr, packetUnit)) / 2 * dt[i];
    rear += (celsius(rl, packetUnit) + celsius(rr, packetUnit)) / 2 * dt[i];
    seconds += dt[i];
    evidenceIndex = i;
  }
  if (seconds < 100 / 60) return null;
  const delta = (front - rear) / seconds;
  if (Math.abs(delta) < 12) return null;
  const { factor, unit } = temperatureScale(packetUnit);
  return {
    id: "tire-temp-split",
    category: "tires",
    severity: Math.abs(delta) > 22 ? "warning" : "info",
    label: "Front/Rear Temp Split",
    detail: `${delta > 0 ? "front" : "rear"} axle ${(Math.abs(delta) * factor).toFixed(0)}${unit} hotter on average — measured thermal balance, not a setup diagnosis`,
    frameIndices: [evidenceIndex],
  };
}

const SURFACE_PROFILE_FIELDS = {
  FL: ["TireSurfaceTempInnerFL", "TireSurfaceTempMiddleFL", "TireSurfaceTempOuterFL"],
  FR: ["TireSurfaceTempInnerFR", "TireSurfaceTempMiddleFR", "TireSurfaceTempOuterFR"],
  RL: ["TireSurfaceTempInnerRL", "TireSurfaceTempMiddleRL", "TireSurfaceTempOuterRL"],
  RR: ["TireSurfaceTempInnerRR", "TireSurfaceTempMiddleRR", "TireSurfaceTempOuterRR"],
} as const satisfies Record<Wheel, readonly [keyof TelemetryPacket, keyof TelemetryPacket, keyof TelemetryPacket]>;

/** Observe repeatable tread gradients; temperatures alone cannot diagnose setup. */
export function detectTireSurfaceProfile(telemetry: TelemetryPacket[], packetUnit: TireTemperaturePacketUnit): LapInsight[] {
  const { factor, unit } = temperatureScale(packetUnit);
  const dt = eventDurations(telemetry);
  const insights: LapInsight[] = [];

  for (const wheel of WHEELS) {
    const [innerField, middleField, outerField] = SURFACE_PROFILE_FIELDS[wheel];
    const windows: { edge: number; shape: number; edgeSign: number; shapeSign: number; frame: number }[] = [];
    let waiting = 3;
    let seconds = 0;
    let edgeTotal = 0;
    let shapeTotal = 0;
    let positiveEdge = 0;
    let negativeEdge = 0;
    let positiveShape = 0;
    let negativeShape = 0;
    let startTemp = 0;
    let start = 0;

    for (let i = 0; i < telemetry.length; i++) {
      const packet = telemetry[i];
      const innerValue = temperatureValue(packet, innerField);
      const middleValue = temperatureValue(packet, middleField);
      const outerValue = temperatureValue(packet, outerField);
      if (!(dt[i] > 0) || !activeTireSample(packet) || innerValue === undefined || middleValue === undefined || outerValue === undefined) {
        waiting = 3;
        seconds = edgeTotal = shapeTotal = positiveEdge = negativeEdge = positiveShape = negativeShape = 0;
        continue;
      }
      const inner = celsius(innerValue, packetUnit);
      const middle = celsius(middleValue, packetUnit);
      const outer = celsius(outerValue, packetUnit);
      const temp = (inner + middle + outer) / 3;
      const edge = inner - outer;
      const shape = middle - (inner + outer) / 2;
      let available = dt[i];
      while (available > 1e-9) {
        if (waiting > 1e-9) {
          const skipped = Math.min(waiting, available);
          waiting -= skipped;
          available -= skipped;
          continue;
        }
        if (seconds === 0) {
          start = i;
          startTemp = temp;
        }
        const used = Math.min(available, 2 - seconds);
        edgeTotal += edge * used;
        shapeTotal += shape * used;
        if (edge >= 10) positiveEdge += used;
        if (edge <= -10) negativeEdge += used;
        if (shape >= 8) positiveShape += used;
        if (shape <= -8) negativeShape += used;
        seconds += used;
        available -= used;
        if (seconds < 2 - 1e-9) continue;
        // Reject windows dominated by heating/cooling, not just a brief flash.
        const stable = Math.abs(temp - startTemp) <= 2;
        windows.push({
          edge: edgeTotal / seconds,
          shape: shapeTotal / seconds,
          edgeSign: stable && positiveEdge >= 1.6 ? 1 : stable && negativeEdge >= 1.6 ? -1 : 0,
          shapeSign: stable && positiveShape >= 1.6 ? 1 : stable && negativeShape >= 1.6 ? -1 : 0,
          frame: Math.round((start + i) / 2),
        });
        seconds = edgeTotal = shapeTotal = positiveEdge = negativeEdge = positiveShape = negativeShape = 0;
        waiting = 1;
      }
    }

    for (const kind of ["edge", "shape"] as const) {
      const signField = kind === "edge" ? "edgeSign" : "shapeSign";
      for (const sign of [-1, 1]) {
        const matches = windows.filter((window) => window[signField] === sign);
        // Require separate two-second windows and persistence into the later run.
        const later = windows.slice(Math.floor(windows.length / 2));
        if (matches.length < 3 || matches.length < windows.length * 0.6 ||
          later.filter((window) => window[signField] === sign).length < later.length * 0.6) continue;
        const delta = matches.reduce((sum, window) => sum + window[kind], 0) / matches.length;
        insights.push({
          id: `tire-surface-${kind === "edge" ? "edge-imbalance" : "pressure-shape"}-${wheel}`,
          category: "tires",
          severity: "info",
          label: kind === "edge" ? "Persistent Tire Edge Gradient" : "Persistent Tire Tread Gradient",
          detail: `${wheel} ${kind === "edge" ? (sign > 0 ? "inner edge" : "outer edge") : (sign > 0 ? "center" : "shoulders")} averaged ${(Math.abs(delta) * factor).toFixed(1)}${unit} hotter across ${matches.length} separated operating windows — observed thermal pattern, not a camber or pressure diagnosis`,
          frameIndices: matches.map((window) => window.frame),
        });
      }
    }
  }
  return insights;
}

export function detectTirePressureImbalance(telemetry: TelemetryPacket[], rapidPressureLoss: readonly LapInsight[] = []): LapInsight | null {
  const dt = eventDurations(telemetry);
  const excludedFrom = [Infinity, Infinity];
  for (const insight of rapidPressureLoss) {
    const wheel = WHEELS.find((candidate) => insight.id === `tire-rapid-pressure-loss-${candidate}`);
    if (!wheel) continue;
    const axle = wheel[0] === "F" ? 0 : 1;
    for (const frame of insight.frameIndices) excludedFrom[axle] = Math.min(excludedFrom[axle], frame);
  }
  const totals = [0, 0];
  const seconds = [0, 0];
  const peakDelta = [0, 0];
  const peakIndex = [0, 0];
  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    if (!(dt[i] > 0) || !activeTireSample(packet)) continue;
    for (let axle = 0; axle < 2; axle++) {
      if (i >= excludedFrom[axle]) continue;
      const left = axle === 0 ? packet.TirePressureFrontLeft : packet.TirePressureRearLeft;
      const right = axle === 0 ? packet.TirePressureFrontRight : packet.TirePressureRearRight;
      if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) continue;
      const delta = left - right;
      totals[axle] += delta * dt[i];
      seconds[axle] += dt[i];
      if (Math.abs(delta) > peakDelta[axle]) {
        peakDelta[axle] = Math.abs(delta);
        peakIndex[axle] = i;
      }
    }
  }
  const front = seconds[0] >= 100 / 60 ? totals[0] / seconds[0] : 0;
  const rear = seconds[1] >= 100 / 60 ? totals[1] / seconds[1] : 0;
  const axle = Math.abs(front) >= Math.abs(rear) ? 0 : 1;
  const delta = axle === 0 ? front : rear;
  if (Math.abs(delta) < 1.5) return null;
  return {
    id: "tire-pressure-imbalance",
    category: "tires",
    severity: Math.abs(delta) >= 3 ? "critical" : "warning",
    label: "Tire Pressure Imbalance",
    detail: `${axle === 0 ? "front" : "rear"} ${delta > 0 ? "left" : "right"} tire averaged ${Math.abs(delta).toFixed(1)} psi higher — compare pressure histories and cold settings`,
    frameIndices: [peakIndex[axle]],
  };
}

const PRESSURE_FIELDS = ["TirePressureFrontLeft", "TirePressureFrontRight", "TirePressureRearLeft", "TirePressureRearRight"] as const;
const WEAR_FIELDS = ["TireWearFL", "TireWearFR", "TireWearRL", "TireWearRR"] as const;

interface PressureWindow {
  seconds: number;
  frame: number;
  pressures: number[];
  temperatures: (number | undefined)[];
}

function median3(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}

/** Continuous direct pressure only; a temporal loss is not proof of a puncture. */
export function detectRapidPressureLoss(telemetry: TelemetryPacket[], packetUnit: TireTemperaturePacketUnit = "celsius"): LapInsight[] {
  const dt = eventDurations(telemetry);
  const history: PressureWindow[] = [];
  const pending: ({ baseline: PressureWindow; seconds: number; frame: number } | undefined)[] = new Array(4);
  const reported = [false, false, false, false];
  const results: (LapInsight | undefined)[] = new Array(4);
  const sums = [0, 0, 0, 0];
  const minima = [Infinity, Infinity, Infinity, Infinity];
  const maxima = [-Infinity, -Infinity, -Infinity, -Infinity];
  const temperatureSums = [0, 0, 0, 0];
  const temperatureSeconds = [0, 0, 0, 0];
  let elapsed = 0;
  let seconds = 0;
  let start = 0;

  for (let i = 0; i < telemetry.length; i++) {
    const packet = telemetry[i];
    const previous = telemetry[i - 1];
    const tireChange = previous && (
      packet.sessionUID !== previous.sessionUID ||
      packet.TyreCompound !== previous.TyreCompound ||
      packet.acc?.tireCompound !== previous.acc?.tireCompound ||
      packet.f1?.actualTyreCompound !== previous.f1?.actualTyreCompound ||
      packet.f1?.tyreCompound !== previous.f1?.tyreCompound ||
      (packet.f1?.tyreAge != null && previous.f1?.tyreAge != null && packet.f1.tyreAge < previous.f1.tyreAge) ||
      WEAR_FIELDS.some((field) => Number.isFinite(packet[field]) && Number.isFinite(previous[field]) && previous[field] - packet[field] > 0.05)
    );
    const valid = dt[i] > 0 && activeTireSample(packet) && PRESSURE_FIELDS.every((field) => {
      const pressure = packet[field];
      return pressure !== undefined && Number.isFinite(pressure) && pressure > 0;
    });
    if (!valid || tireChange) {
      history.length = 0;
      pending.fill(undefined);
      reported.fill(false);
      sums.fill(0);
      minima.fill(Infinity);
      maxima.fill(-Infinity);
      temperatureSums.fill(0);
      temperatureSeconds.fill(0);
      elapsed = seconds = 0;
      continue;
    }
    let available = dt[i];
    while (available > 1e-9) {
      if (seconds === 0) start = i;
      const used = Math.min(available, 1 - seconds);
      for (let w = 0; w < 4; w++) {
        const pressure = packet[PRESSURE_FIELDS[w]]!;
        sums[w] += pressure * used;
        minima[w] = Math.min(minima[w], pressure);
        maxima[w] = Math.max(maxima[w], pressure);
        const temperature = temperatureValue(packet, CORE_TEMPERATURE_FIELDS[WHEELS[w]]) ??
          temperatureValue(packet, PRIMARY_TEMPERATURE_FIELDS[WHEELS[w]]);
        if (temperature !== undefined) {
          temperatureSums[w] += celsius(temperature, packetUnit) * used;
          temperatureSeconds[w] += used;
        }
      }
      elapsed += used;
      seconds += used;
      available -= used;
      if (seconds < 1 - 1e-9) continue;

      while (history.length > 0 && elapsed - history[0].seconds > 8) history.shift();
      // A spike or transition cannot be its own baseline or sustained evidence.
      const stable = maxima.every((maximum, w) => maximum - minima[w] <= 1);
      if (stable) {
        const current: PressureWindow = {
          seconds: elapsed,
          frame: start,
          pressures: sums.map((sum) => sum / seconds),
          temperatures: temperatureSums.map((sum, w) => temperatureSeconds[w] >= seconds * 0.9 ? sum / temperatureSeconds[w] : undefined),
        };
        let baseline: PressureWindow | undefined;
        if (history.length >= 3 && history[2].seconds - history[0].seconds <= 2.1) {
          const [a, b, c] = history;
          baseline = {
            seconds: b.seconds,
            frame: b.frame,
            pressures: WHEELS.map((_, w) => median3(a.pressures[w], b.pressures[w], c.pressures[w])),
            temperatures: WHEELS.map((_, w) => {
              const x = a.temperatures[w], y = b.temperatures[w], z = c.temperatures[w];
              return x === undefined || y === undefined || z === undefined ? undefined : median3(x, y, z);
            }),
          };
        }
        for (let w = 0; w < 4; w++) {
          if (reported[w]) continue;
          const reference = pending[w]?.baseline ?? baseline;
          if (!reference) continue;
          if (!pending[w] && Math.max(history[0].pressures[w], history[1].pressures[w], history[2].pressures[w]) -
            Math.min(history[0].pressures[w], history[1].pressures[w], history[2].pressures[w]) > 0.75) continue;
          const drop = reference.pressures[w] - current.pressures[w];
          const p1 = (w + 1) % 4, p2 = (w + 2) % 4, p3 = (w + 3) % 4;
          const peerDrop = median3(
            reference.pressures[p1] - current.pressures[p1],
            reference.pressures[p2] - current.pressures[p2],
            reference.pressures[p3] - current.pressures[p3],
          );
          const beforeTemp = reference.temperatures[w];
          const afterTemp = current.temperatures[w];
          // Ideal-gas cooling is an exclusion, not an estimate of tire damage.
          const coolingDrop = beforeTemp !== undefined && afterTemp !== undefined
            ? Math.max(0, (reference.pressures[w] + 14.7) * (beforeTemp - afterTemp) / (beforeTemp + 273.15))
            : 0;
          if (drop < Math.max(2, reference.pressures[w] * 0.08) || drop - peerDrop < 1.5 || drop - coolingDrop < 1.5) {
            pending[w] = undefined;
            continue;
          }
          const candidate = pending[w] ?? { baseline: reference, seconds: 0, frame: current.frame };
          candidate.seconds += seconds;
          pending[w] = candidate;
          if (candidate.seconds < 2 - 1e-9) continue;
          reported[w] = true;
          const existing = results[w];
          if (existing) {
            existing.frameIndices.push(candidate.frame);
          } else {
            results[w] = {
              id: `tire-rapid-pressure-loss-${WHEELS[w]}`,
              category: "tires",
              severity: "warning",
              label: "Rapid Tire Pressure Loss",
              detail: `${WHEELS[w]} pressure fell ${drop.toFixed(1)} psi to ${current.pressures[w].toFixed(1)} psi relative to its recent baseline and peer tires, sustained for at least 2 seconds — inspect the tire; cause is not confirmed`,
              frameIndices: [candidate.frame],
            };
          }
        }
        history.push(current);
      } else {
        pending.fill(undefined);
      }
      sums.fill(0);
      minima.fill(Infinity);
      maxima.fill(-Infinity);
      temperatureSums.fill(0);
      temperatureSeconds.fill(0);
      seconds = 0;
    }
  }
  return results.filter((insight): insight is LapInsight => insight !== undefined);
}
