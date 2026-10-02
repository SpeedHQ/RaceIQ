import type { PitEvent, PitService } from "./types";

export interface PitServiceSignals {
  sequence?: number;
  lapNumber?: number | null;
  elapsedSeconds?: number | null;
  durationSeconds?: number | null;
  tyreChange?: unknown;
  fuelAdded?: number | null;
  fuelBefore?: number | null;
  fuelAfter?: number | null;
  linkage?: PitEvent["linkage"];
  source?: Record<string, unknown>;
}

export function classifyPitService(signals: PitServiceSignals): PitService {
  const hasTyres = signals.tyreChange != null;
  const hasFuel = signals.fuelAdded != null;
  if (hasTyres && hasFuel) return "combined";
  if (hasTyres) return "tyres";
  if (hasFuel) return "fuel";
  return "unknown";
}

export function derivePitLedger(signals: PitServiceSignals[]): PitEvent[] {
  return signals
    .map((signal, index) => ({
      sequence: signal.sequence ?? index + 1,
      lapNumber: signal.lapNumber ?? null,
      elapsedSeconds: signal.elapsedSeconds ?? null,
      durationSeconds: signal.durationSeconds ?? null,
      service: classifyPitService(signal),
      tyreChange: signal.tyreChange ?? null,
      fuelAdded: signal.fuelAdded ?? null,
      fuelBefore: signal.fuelBefore ?? null,
      fuelAfter: signal.fuelAfter ?? null,
      linkage: signal.linkage ?? "unknown",
      source: signal.source ?? {},
    }))
    .sort((a, b) => a.sequence - b.sequence)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}
