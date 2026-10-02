import type { TelemetryPacket } from "../../../../telemetry/types";
import type { TelemetryModel } from "../../../../games/types";
import { appendInsights, INSIGHT_ORDER, insightAt, type LapInsight, type OrderedInsight, eventDurations, midFrame } from "./types";
import { runSelectedInsightScan, type InsightAccumulator } from "./scan";

interface EventRun {
  observe(index: number, seconds: number, flag: boolean, minimum: number): void;
  finish(minimum: number): [number, number][];
}

function createEventRun(): EventRun {
  const events: [number, number][] = [];
  let start = -1;
  let end = -1;
  let active = 0;
  let gap = 0;
  const flush = (minimum: number) => {
    if (start >= 0 && active + 1e-9 >= minimum) events.push([start, end]);
    start = -1;
    active = 0;
    gap = 0;
  };
  return {
    observe(index, seconds, flag, minimum) {
      if (!(seconds > 0) || !Number.isFinite(seconds)) {
        flush(minimum);
      } else if (flag) {
        if (start < 0) start = index;
        end = index;
        active += seconds;
        gap = 0;
      } else if (start >= 0) {
        gap += seconds;
        if (gap > 1e-9) flush(minimum);
      }
    },
    finish(minimum) {
      flush(minimum);
      return events;
    },
  };
}

type FuelPacketUnit = TelemetryModel["fuel"]["packetUnit"];

export interface MechanicalScanOptions {
  packetUnit: FuelPacketUnit;
}


export function createMechanicalScan(
  telemetry: readonly TelemetryPacket[],
  options: MechanicalScanOptions,
): InsightAccumulator {
  let firstFuel = 0;
  let lastFuel = 0;
  let maxBoost = 0;
  const run = createEventRun();
  const peakIndices: number[] = [];
  let peakHead = 0;
  return {
    observe(index, seconds) {
      const packet = telemetry[index];
      if (index === 0) firstFuel = packet.Fuel;
      lastFuel = packet.Fuel;
      maxBoost = Math.max(maxBoost, packet.Boost);
      if (!(seconds > 0) || !Number.isFinite(packet.Boost) || packet.Accel <= 240 ||
        (index > 0 && packet.Gear !== telemetry[index - 1].Gear)) {
        peakIndices.length = 0;
        peakHead = 0;
        run.observe(index, seconds, false, 5 / 60);
        return;
      }
      while (peakHead < peakIndices.length &&
        packet.TimestampMS - telemetry[peakIndices[peakHead]].TimestampMS > 1000) peakHead++;
      while (peakIndices.length > peakHead &&
        telemetry[peakIndices[peakIndices.length - 1]].Boost <= packet.Boost) peakIndices.pop();
      peakIndices.push(index);
      const rollingPeak = telemetry[peakIndices[peakHead]].Boost;
      run.observe(index, seconds, packet.Accel > 240 && rollingPeak > 0 && packet.Boost < rollingPeak * 0.5, 5 / 60);
    },
    finish() {
      const used = firstFuel - lastFuel;
      let fuel: LapInsight | null = null;
      if (telemetry.length >= 2 && used > 0) {
        const lapsRemaining = lastFuel > 0 ? lastFuel / used : Number.POSITIVE_INFINITY;
        const usedLabel = options.packetUnit === "litre" ? `${used.toFixed(2)} L` : `${(used * 100).toFixed(1)}%`;
        fuel = {
          id: "mech-fuel",
          category: "mechanical",
          severity: lapsRemaining < 3 ? "critical" : lapsRemaining < 5 ? "warning" : "info",
          label: "Fuel",
          detail: `Used ${usedLabel} — ~${lapsRemaining === Number.POSITIVE_INFINITY ? "∞" : lapsRemaining.toFixed(1)} laps remaining`,
          frameIndices: [telemetry.length - 1],
        };
      }
      const events = run.finish(5 / 60);
      const boost = maxBoost <= 0 || events.length === 0 ? null : {
        id: "mech-boost-anomaly",
        category: "mechanical" as const,
        severity: events.length >= 3 ? "critical" as const : "warning" as const,
        label: "Boost Drop",
        detail: `${events.length} unexpected boost drop${events.length > 1 ? "s" : ""} at full throttle`,
        frameIndices: midFrame(events),
      };
      const results: OrderedInsight[] = [];
      appendInsights(results, INSIGHT_ORDER.fuel, fuel);
      appendInsights(results, INSIGHT_ORDER.boost, boost);
      return results;
    },
  };
}

export function detectFuelConsumption(telemetry: TelemetryPacket[], packetUnit: FuelPacketUnit): LapInsight | null {
  const durations = eventDurations(telemetry);
  return insightAt(runSelectedInsightScan(telemetry, createMechanicalScan(telemetry, { packetUnit }), { durations }), INSIGHT_ORDER.fuel);
}

export function detectBoostAnomaly(telemetry: TelemetryPacket[]): LapInsight | null {
  const durations = eventDurations(telemetry);
  return insightAt(runSelectedInsightScan(telemetry, createMechanicalScan(telemetry, { packetUnit: "fraction" }), { durations }), INSIGHT_ORDER.boost);
}
