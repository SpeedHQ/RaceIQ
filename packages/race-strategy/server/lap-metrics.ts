import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { classifyPitCycleLap } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import type { FourWheels } from "@raceiq/shared/racing/live/strategy";

export const STRATEGY_ALGORITHM_VERSION = "stint-metrics-v2";
export interface LapMetricContribution {
  fuelUsed: number | null;
  fuelExcludedReason: string | null;
  tireWear: FourWheels<number | null>;
  tireExcludedReasons: FourWheels<string | null>;
  lapTimeSeconds: number | null;
  exclusionReason: string | null;
  measuredFuelUsed: number | null;
  fuelCoverage: "complete" | "partial" | "unavailable";
  evidence: { firstTimestampMs: number | null; lastTimestampMs: number | null; samples: number };
}
const channels = ["TireWearFL", "TireWearFR", "TireWearRL", "TireWearRR"] as const;
const wearValid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

/** A single path for live saved laps and source-backed rebuilds. No historical pseudo-laps. */
export function aggregateLapMetrics(packets: readonly TelemetryPacket[], options: {
  valid: boolean; lapTimeSeconds: number; fuelUnit: "L" | "tankFraction";
  allowContinuousWear: boolean; serviceBoundary?: boolean;
}): LapMetricContribution {
  const first = packets[0];
  const last = packets.at(-1);
  const pitReason = classifyPitCycleLap(packets);
  let exclusion = !first || !last || packets.length < 2 ? "insufficient-endpoints" : !options.valid ? "invalid-lap" : pitReason ?? (options.serviceBoundary ? "service-boundary" : null);
  const fuelValid = (value: number) => Number.isFinite(value) && value >= 0 && (options.fuelUnit === "L" || value <= 1);
  let fuelReason: string | null = first && fuelValid(first.Fuel) ? null : "fuel-unavailable";
  const tireReasons: FourWheels<string | null> = [null, null, null, null];
  const tireDeltas: FourWheels<number | null> = [null, null, null, null];
  for (let wheel = 0; wheel < 4; wheel++) {
    if (!options.allowContinuousWear) tireReasons[wheel] = "unsupported-tire-wear-rate";
    else if (!first || !wearValid(first[channels[wheel]])) tireReasons[wheel] = "tire-wear-unavailable";
  }
  let measured = 0;
  let reliableIntervals = 0;
  let allFuelIntervals = packets.length > 1;
  if (first) for (let index = 1; index < packets.length; index++) {
    const previous = packets[index - 1];
    const current = packets[index];
    // Some native detectors retain the next lap's first packet as finish-line context.
    // Only that final rollover sample belongs to this completed interval.
    const finishContext = index === packets.length - 1 && previous.LapNumber === first.LapNumber
      && current.LapNumber === first.LapNumber + 1 && current.CurrentLap < previous.CurrentLap;
    const continuous = Number.isFinite(previous.TimestampMS) && Number.isFinite(current.TimestampMS)
      && current.TimestampMS >= previous.TimestampMS && current.TimestampMS - previous.TimestampMS <= 5_000
      && previous.gameId === first.gameId && previous.carId === first.carId && previous.trackId === first.trackId
      && current.gameId === first.gameId && current.carId === first.carId && current.trackId === first.trackId
      && previous.LapNumber === first.LapNumber && (current.LapNumber === first.LapNumber || finishContext)
      && Number.isFinite(previous.DistanceTraveled) && Number.isFinite(current.DistanceTraveled)
      // LMU derives this channel from scoring lap distance, which can correct
      // backward without a recording gap. It is not a monotonic odometer.
      && (first.gameId === "lmu" || current.DistanceTraveled + 0.1 >= previous.DistanceTraveled);
    if (!continuous) exclusion = "discontinuous-lap";
    const fuelInterval = continuous && fuelValid(previous.Fuel) && fuelValid(current.Fuel) && current.Fuel <= previous.Fuel;
    if (fuelInterval) { measured += previous.Fuel - current.Fuel; reliableIntervals++; }
    else {
      allFuelIntervals = false;
      fuelReason = fuelValid(previous.Fuel) && fuelValid(current.Fuel) && current.Fuel > previous.Fuel ? "fuel-reset-or-refill" : "fuel-unavailable";
    }
    for (let wheel = 0; wheel < 4; wheel++) {
      const before = previous[channels[wheel]];
      const after = current[channels[wheel]];
      if (!wearValid(before) || !wearValid(after)) tireReasons[wheel] ??= "tire-wear-unavailable";
      else if (after < before) tireReasons[wheel] ??= "tire-reset-or-replacement";
    }
  }
  if (exclusion) fuelReason = exclusion;
  for (let wheel = 0; wheel < 4; wheel++) {
    tireReasons[wheel] = exclusion ?? tireReasons[wheel];
    if (!tireReasons[wheel] && first && last) tireDeltas[wheel] = last[channels[wheel]] - first[channels[wheel]];
  }
  return {
    fuelUsed: !fuelReason && first && last ? first.Fuel - last.Fuel : null,
    fuelExcludedReason: fuelReason, tireWear: tireDeltas, tireExcludedReasons: tireReasons,
    lapTimeSeconds: !exclusion && Number.isFinite(options.lapTimeSeconds) && options.lapTimeSeconds > 0 ? options.lapTimeSeconds : null,
    exclusionReason: exclusion, measuredFuelUsed: reliableIntervals > 0 ? measured : null,
    fuelCoverage: reliableIntervals === 0 ? "unavailable" : allFuelIntervals ? "complete" : "partial",
    evidence: { firstTimestampMs: first && Number.isFinite(first.TimestampMS) ? first.TimestampMS : null, lastTimestampMs: last && Number.isFinite(last.TimestampMS) ? last.TimestampMS : null, samples: packets.length },
  };
}
