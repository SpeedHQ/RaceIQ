import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { FourWheels } from "@raceiq/shared/racing/live/strategy";
import type { GameAdapter } from "@raceiq/shared/games/types";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "@raceiq/shared/telemetry/resolver/versions";
import { TELEMETRY_DERIVATION_VERSION } from "@raceiq/telemetry-core/telemetry/derivations/builtins";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { forzaPitTransitionEvidence } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import { getServerGame } from "../games/registry";
import type { StintIdentity } from "./stint-accumulator";

const wearChannels = ["TireWearFL", "TireWearFR", "TireWearRL", "TireWearRR"] as const;

/** Native channel/version identity, not a telemetry-derived setup fingerprint. */
export function strategyContext(packet: TelemetryPacket): Pick<StintIdentity, "gameId" | "carId" | "trackId" | "pi" | "compounds" | "compatibility" | "fuelUnit"> {
  const adapter = getServerGame(packet.gameId);
  const continuousWear = strategyContinuousWear(adapter);
  const fuelUnit = adapter.telemetry.fuel.packetUnit === "fraction" ? "tankFraction" : "L";
  const semanticVersion = `${packet.gameId}:${TELEMETRY_PARSER_VERSIONS[packet.gameId]}:${TELEMETRY_RESOLVER_VERSION}:${TELEMETRY_DERIVATION_VERSION}`;
  let front: string | null = null;
  let rear: string | null = null;
  if (packet.f1) front = rear = packet.f1.tyreCompound || null;
  else if (packet.acc) front = rear = packet.acc.tireCompound || null;
  else if (packet.lmu) { front = packet.lmu.frontTireCompound || null; rear = packet.lmu.rearTireCompound || null; }
  if (front === "unknown") front = null;
  if (rear === "unknown") rear = null;
  const compounds: FourWheels<string | null> = [front, front, rear, rear];
  const tireVersion = continuousWear ? `${semanticVersion}:wear-fraction-worn-v1` : null;
  const temperature = (value: number | undefined): number | null => value != null && Number.isFinite(value) ? value : null;
  return { gameId: packet.gameId, carId: packet.carId, trackId: packet.trackId,
    pi: packet.gameId === "fm-2023" && Number.isFinite(packet.CarPerformanceIndex) && packet.CarPerformanceIndex > 0 ? packet.CarPerformanceIndex : null,
    compounds, fuelUnit,
    compatibility: { fuelSemanticVersion: `${semanticVersion}:fuel-${fuelUnit}-v1`, tireSemanticVersions: [tireVersion, tireVersion, tireVersion, tireVersion], setupKey: null,
      conditions: { weather: packet.f1 ? String(packet.f1.weather) : null, airTemperatureC: temperature(packet.f1?.airTemperature), trackTemperatureC: temperature(packet.f1?.trackTemperature) } } };
}

export const StrategyBoundary = { Rewind: 1, Configuration: 2, Tires: 4, Fuel: 8, Pit: 16, Gap: 32 } as const;
/** Boundary evidence is shared by live ingestion and offline source-backed rebuilding. */
export function strategyBoundary(before: TelemetryPacket, after: TelemetryPacket): number {
  let result = 0;
  if (after.TimestampMS < before.TimestampMS) result |= StrategyBoundary.Rewind;
  if (after.TimestampMS - before.TimestampMS > 5_000 || after.LapNumber > before.LapNumber + 1 || after.LapNumber < before.LapNumber) result |= StrategyBoundary.Gap;
  if (after.gameId !== before.gameId || after.carId !== before.carId || after.trackId !== before.trackId ||
    after.gameId === "fm-2023" && after.CarPerformanceIndex !== before.CarPerformanceIndex ||
    after.f1?.tyreCompound !== before.f1?.tyreCompound || after.acc?.tireCompound !== before.acc?.tireCompound ||
    after.lmu?.frontTireCompound !== before.lmu?.frontTireCompound || after.lmu?.rearTireCompound !== before.lmu?.rearTireCompound) result |= StrategyBoundary.Configuration;
  for (const wheel of wearChannels) {
    if (Number.isFinite(after[wheel]) && after[wheel] >= 0 && before[wheel] >= 0 && before[wheel] - after[wheel] >= 0.005) result |= StrategyBoundary.Tires;
  }
  if (Number.isFinite(after.Fuel) && before.Fuel >= 0 && after.Fuel - before.Fuel >= 0.005) result |= StrategyBoundary.Fuel;
  const pit = strategyPitState(after);
  const wasPit = strategyPitState(before);
  if (pit != null && wasPit != null && pit !== wasPit ||
    after.gameId === "fm-2023" && after.LapNumber > before.LapNumber && forzaPitTransitionEvidence(before, after).detected) result |= StrategyBoundary.Pit;
  return result;
}
export function strategyBoundaryReason(boundary: number): string {
  if (boundary & StrategyBoundary.Rewind) return "timebase-discontinuity";
  if (boundary & StrategyBoundary.Gap) return "source-gap";
  if (boundary & StrategyBoundary.Configuration) return "configuration-change";
  if (boundary & StrategyBoundary.Tires) return "tire-replacement";
  if (boundary & StrategyBoundary.Fuel) return "refill";
  return "pit-visit";
}

export function strategyPitState(packet: TelemetryPacket): boolean | undefined {
  if (packet.iracing) return packet.iracing.onPitRoad;
  if (packet.lmu) return packet.lmu.inPits;
  if (packet.acc) return packet.acc.pitStatus == null ? undefined : packet.acc.pitStatus !== "out";
  if (packet.f1) return packet.f1.pitLaneTimerActive == null ? undefined : packet.f1.pitLaneTimerActive === 1;
  return undefined;
}

/** Rates are derived from continuous native wear, never from a pit-only snapshot. */
export function strategyContinuousWear(adapter: GameAdapter): boolean {
  const analysis = resolveAnalysisTelemetry(adapter);
  return analysis.tireWearRate.source !== "unavailable" && analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "continuous";
}
