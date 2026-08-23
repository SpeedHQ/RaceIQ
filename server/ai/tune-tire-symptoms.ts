/**
 * Resolver-backed tyre thermal diagnosis. Surface and carcass channels use
 * canonical °C values and four-wheel semantic order: FL, FR, RL, RR.
 */
import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { semanticFixedNumbers, semanticNumber } from "../telemetry/semantic-samples";

export type TireCorner = "FL" | "FR" | "RL" | "RR";
type CamberBias = "excess_negative" | "insufficient_negative" | "balanced";
type PressureBias = "over" | "under" | "balanced";
type ThermalState = "cold" | "optimal" | "hot";

export interface TireCornerTemp {
  corner: TireCorner;
  coreTempC: number;
  innerVsOuterC: number;
  crownVsShoulderC: number | null;
  camberBias: CamberBias;
  pressureBias: PressureBias | null;
  thermal: ThermalState;
}

export interface TireTempSymptoms {
  corners: TireCornerTemp[];
  frontMinusRearC: number;
  leftMinusRightC: number;
  hottestCorner: TireCorner;
}

const CAMBER_SPREAD_C = 5;
const PRESSURE_SPREAD_C = 4;
const CORE_TEMP_COLD_C = 65;
const CORE_TEMP_HOT_C = 100;
const MIN_FRAMES = 30;
const WHEELS = 4;
const ORDER: readonly TireCorner[] = ["FL", "FR", "RL", "RR"];

function camberBias(innerVsOuterC: number): CamberBias {
  if (innerVsOuterC > CAMBER_SPREAD_C) return "excess_negative";
  if (innerVsOuterC < -CAMBER_SPREAD_C) return "insufficient_negative";
  return "balanced";
}

function pressureBias(crownVsShoulderC: number | null): PressureBias | null {
  if (crownVsShoulderC == null) return null;
  if (crownVsShoulderC > PRESSURE_SPREAD_C) return "over";
  if (crownVsShoulderC < -PRESSURE_SPREAD_C) return "under";
  return "balanced";
}

function thermalState(coreTempC: number): ThermalState {
  if (coreTempC < CORE_TEMP_COLD_C) return "cold";
  if (coreTempC > CORE_TEMP_HOT_C) return "hot";
  return "optimal";
}

export function tireTempSymptoms(gameId: GameId, samples: readonly SemanticTelemetrySample[]): TireTempSymptoms | null {
  if (!gameId) throw new Error("gameId is required for tyre symptom analysis");

  const coreTotals = [0, 0, 0, 0];
  const innerTotals = [0, 0, 0, 0];
  const outerTotals = [0, 0, 0, 0];
  const middleTotals = [0, 0, 0, 0];
  const middleCounts = [0, 0, 0, 0];
  let loaded = 0;

  for (const sample of samples) {
    const speed = semanticNumber(sample, "motion.speed");
    if (speed == null || speed <= 5) continue;
    const core = semanticFixedNumbers(sample, "tire.temperature.carcass.average", WHEELS);
    const inner = semanticFixedNumbers(sample, "tires.tire-inner-temp", WHEELS);
    const outer = semanticFixedNumbers(sample, "tire.temperature.surface.outer", WHEELS);
    if (!core || !inner || !outer || core.some((value) => value <= 0)) continue;
    const middle = semanticFixedNumbers(sample, "tire.temperature.surface.middle", WHEELS);
    for (let index = 0; index < WHEELS; index += 1) {
      coreTotals[index] += core[index];
      innerTotals[index] += inner[index];
      outerTotals[index] += outer[index];
      if (middle) {
        middleTotals[index] += middle[index];
        middleCounts[index] += 1;
      }
    }
    loaded += 1;
  }
  if (loaded < MIN_FRAMES) return null;

  const corners: TireCornerTemp[] = ORDER.map((corner, index) => {
    const core = coreTotals[index] / loaded;
    const inner = innerTotals[index] / loaded;
    const outer = outerTotals[index] / loaded;
    const crownVsShoulderC = middleCounts[index] > 0 ? middleTotals[index] / middleCounts[index] - (inner + outer) / 2 : null;
    const innerVsOuterC = inner - outer;
    return {
      corner,
      coreTempC: core,
      innerVsOuterC,
      crownVsShoulderC,
      camberBias: camberBias(innerVsOuterC),
      pressureBias: pressureBias(crownVsShoulderC),
      thermal: thermalState(core),
    };
  });

  const frontMinusRearC = (corners[0].coreTempC + corners[1].coreTempC - corners[2].coreTempC - corners[3].coreTempC) / 2;
  const leftMinusRightC = (corners[0].coreTempC + corners[2].coreTempC - corners[1].coreTempC - corners[3].coreTempC) / 2;
  const hottestCorner = corners.reduce((hottest, corner) => (corner.coreTempC > hottest.coreTempC ? corner : hottest)).corner;
  return { corners, frontMinusRearC, leftMinusRightC, hottestCorner };
}

export function formatTireTempSymptoms(t: TireTempSymptoms | null): string {
  if (!t) return "Tyre temp data unavailable for this game.";
  const camberWord: Record<CamberBias, string> = {
    excess_negative: "inner hot (excess neg camber)",
    insufficient_negative: "outer hot (needs more neg camber)",
    balanced: "even",
  };
  const pressureWord: Record<PressureBias, string> = {
    over: "crown hot (over-pressure)",
    under: "shoulders hot (under-pressure)",
    balanced: "even",
  };
  const lines = t.corners
    .map((corner) => {
      const parts = [
        `core ${corner.coreTempC.toFixed(0)}°C (${corner.thermal})`,
        `camber: ${camberWord[corner.camberBias]} (Δi/o ${corner.innerVsOuterC.toFixed(1)}°C)`,
        corner.pressureBias && corner.crownVsShoulderC != null ? `pressure: ${pressureWord[corner.pressureBias]} (Δcrown ${corner.crownVsShoulderC.toFixed(1)}°C)` : null,
      ].filter(Boolean);
      return `  ${corner.corner} — ${parts.join(", ")}`;
    })
    .join("\n");
  return `Tyre temps (hottest ${t.hottestCorner}; front−rear ${t.frontMinusRearC.toFixed(1)}°C, left−right ${t.leftMinusRightC.toFixed(1)}°C):
${lines}`;
}
