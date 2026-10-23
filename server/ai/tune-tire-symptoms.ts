/**
 * Deterministic core tire-temperature diagnosis for the auto-tune pipeline.
 *
 * ACC and AC Evo expose a valid per-wheel core temperature, but their shared
 * memory surface-band fields are reserved placeholders. Keep this analysis
 * restricted to the measured core channel.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getPacketTireCompound, getTireCoreTempRange } from "@raceiq/shared/racing/live/tire-thresholds";

export type TireCorner = "FL" | "FR" | "RL" | "RR";
type ThermalState = "cold" | "optimal" | "hot";

interface TireCornerTemp {
  corner: TireCorner;
  /** Mean core temperature over loaded frames, °C. */
  coreTempC: number;
  /** Core temp vs the optimal window. */
  thermal: ThermalState;
}

interface TireTempSymptoms {
  corners: TireCornerTemp[];
  /** Mean core temp front axle − rear axle, °C. +ve = fronts hotter. */
  frontMinusRearC: number;
  /** Mean core temp left side − right side, °C. +ve = left hotter. */
  leftMinusRightC: number;
  /** Corner label of the hottest tyre by core temp, for quick reference. */
  hottestCorner: TireCorner;
}

// Minimum loaded frames before a corner's temps are trusted.
const MIN_FRAMES = 30;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Optimal core window comes from game metadata for the fitted compound. */
function thermalState(coreTempC: number, gameId: TelemetryPacket["gameId"], compound: string): ThermalState {
  const range = getTireCoreTempRange(gameId, compound);
  if (coreTempC < range.min) return "cold";
  if (coreTempC > range.max) return "hot";
  return "optimal";
}

/**
 * Reduce a stint to a per-tire core-temperature report, or null when the
 * measured channel is absent. Stationary frames are excluded.
 */
export function tireTempSymptoms(packets: TelemetryPacket[]): TireTempSymptoms | null {
  const loaded = packets.filter((packet) =>
    packet.acc?.tireCoreTemp != null
    && packet.acc.tireCoreTemp.every(Number.isFinite)
    && (packet.Speed ?? 0) > 5
  );
  if (loaded.length < MIN_FRAMES) return null;

  const order: TireCorner[] = ["FL", "FR", "RL", "RR"];
  const corners: TireCornerTemp[] = order.map((corner, index) => {
    const core = mean(loaded.map((packet) => packet.acc!.tireCoreTemp[index]));
    return {
      corner,
      coreTempC: core,
      thermal: thermalState(core, loaded[0]!.gameId, getPacketTireCompound(loaded[0]!, index)),
    };
  });

  const coreOf = (corner: TireCorner) => corners.find((entry) => entry.corner === corner)!.coreTempC;
  const frontMinusRearC = (coreOf("FL") + coreOf("FR")) / 2 - (coreOf("RL") + coreOf("RR")) / 2;
  const leftMinusRightC = (coreOf("FL") + coreOf("RL")) / 2 - (coreOf("FR") + coreOf("RR")) / 2;
  const hottestCorner = corners.reduce((a, b) => (b.coreTempC > a.coreTempC ? b : a)).corner;

  return { corners, frontMinusRearC, leftMinusRightC, hottestCorner };
}

/**
 * Render a tyre-temp report as prompt prose. Shared by the tune-intent and
 * setup-engineer/tune-chat symptom formatters so both surface the same
 * evidence. `null` (channels absent) collapses to a single unavailable line.
 */
export function formatTireTempSymptoms(t: TireTempSymptoms | null): string {
  if (!t) return "Tyre temp data unavailable for this game.";
  const lines = t.corners
    .map((corner) => `  ${corner.corner} — core ${corner.coreTempC.toFixed(0)}°C (${corner.thermal})`)
    .join("\n");
  return `Tyre core temps (hottest ${t.hottestCorner}; front−rear ${t.frontMinusRearC.toFixed(1)}°C, left−right ${t.leftMinusRightC.toFixed(1)}°C):
${lines}`;
}
