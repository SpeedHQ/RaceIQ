import { getGame, tryGetGame } from "../../games/registry";
import type { GameId } from "../../games/ids";
import type { TelemetryPacket } from "../../telemetry/types";

export type TireThresholds = { cliffPct: number; deadPct: number };
export type TireThresholdOverrides = Partial<Record<GameId, Record<string, TireThresholds>>>;
export interface TireTemperatureRange { min: number; max: number }

const F1_COMPOUNDS = ["default", "soft", "medium", "hard", "inter", "wet"] as const;
const ACC_COMPOUNDS = ["default", "dry_compound", "wet_compound"] as const;
const DEFAULT_COMPOUND_OPTIONS = ["default"] as const;
const DEFAULT_DEAD_PCT = 20;

export function getPacketTireCompound(packet: TelemetryPacket, wheel: number): string {
  let compound: string | undefined;
  if (packet.f1) compound = packet.f1.tyreCompound;
  else if (packet.acc) compound = packet.acc.tireCompound;
  else if (packet.lmu) compound = wheel < 2 ? packet.lmu.frontTireCompound : packet.lmu.rearTireCompound;
  const normalized = compound?.trim().toLowerCase();
  return normalized && normalized !== "unknown" ? normalized : "default";
}

export function getTireThresholds(
  overrides: TireThresholdOverrides,
  gameId: GameId,
  compound: string,
): TireThresholds {
  const normalizedCompound = compound.trim().toLowerCase() || "default";
  const configured = overrides[gameId]?.[normalizedCompound] ??
    (normalizedCompound === "default" ? overrides[gameId]?.default : undefined);
  if (configured) return configured;
  const game = getGame(gameId);
  return { cliffPct: game.tireHealthThresholds.yellow * 100, deadPct: DEFAULT_DEAD_PCT };
}

export function getTireCompoundOptions(gameId: GameId): readonly string[] {
  if (gameId === "f1-2025") return F1_COMPOUNDS;
  if (gameId === "acc" || gameId === "ac-evo") return ACC_COMPOUNDS;
  return DEFAULT_COMPOUND_OPTIONS;
}

/** Optimal core/carcass window for the fitted compound, falling back to the game's primary temp bands. */
export function getTireCoreTempRange(gameId: GameId, compound: string): TireTemperatureRange {
  const game = getGame(gameId);
  const normalized = compound.trim().toLowerCase() || "default";
  return game.tireCoreTempOptimal?.compounds?.[normalized] ?? game.tireCoreTempOptimal?.default ??
    { min: game.tireTempThresholds.cold, max: game.tireTempThresholds.warm };
}

/** Per-compound optimal windows published by game metadata; empty when the game has none. */
export function getTireCoreTempGuide(gameId: GameId): { compound: string; min: number; max: number }[] {
  const optimal = tryGetGame(gameId)?.tireCoreTempOptimal;
  if (!optimal) return [];
  const compounds = Object.entries(optimal.compounds ?? {});
  return (compounds.length ? compounds : [["default", optimal.default] as const])
    .map(([compound, range]) => ({ compound, min: range.min, max: range.max }));
}
