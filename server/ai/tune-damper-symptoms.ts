/**
 * Resolver-backed damper diagnosis. Normalized travel is canonical ratio with
 * semantic wheel order FL, FR, RL, RR.
 */
import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { semanticFixedNumbers, semanticNumber } from "../telemetry/semantic-samples";
import type { TireCorner } from "./tune-tire-symptoms";

type TravelUse = "stiff" | "optimal" | "soft";
type DamperBias = "bump_biased" | "rebound_biased" | "balanced";

export interface DamperCornerSymptom {
  corner: TireCorner;
  meanCompression: number;
  travelRangePct: number;
  bottomingPct: number;
  toppingPct: number;
  bumpVel: number;
  reboundVel: number;
  fastEventPct: number;
  travelUse: TravelUse;
  damperBias: DamperBias;
}

export interface DamperSymptoms {
  corners: DamperCornerSymptom[];
  frontMinusRearRangePct: number;
  bottomingCorners: TireCorner[];
  softestCorner: TireCorner;
  stiffestCorner: TireCorner;
}

const STIFF_RANGE_PCT = 25;
const SOFT_RANGE_PCT = 70;
const DAMPER_ASYM_RATIO = 1.35;
const FAST_DAMPER_VEL = 0.02;
const BOTTOMING_PCT = 2;
const BUMP_STOP = 0.95;
const DROOP_STOP = 0.05;
const MIN_FRAMES = 30;
const WHEELS = 4;
const ORDER: readonly TireCorner[] = ["FL", "FR", "RL", "RR"];

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return values.length > 0 ? total / values.length : 0;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentileValue;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function travelUse(rangePct: number): TravelUse {
  if (rangePct < STIFF_RANGE_PCT) return "stiff";
  if (rangePct > SOFT_RANGE_PCT) return "soft";
  return "optimal";
}

function damperBias(bumpVel: number, reboundVel: number): DamperBias {
  if (reboundVel <= 0 && bumpVel <= 0) return "balanced";
  if (reboundVel <= 0) return "bump_biased";
  if (bumpVel <= 0) return "rebound_biased";
  const ratio = bumpVel / reboundVel;
  if (ratio > DAMPER_ASYM_RATIO) return "bump_biased";
  if (ratio < 1 / DAMPER_ASYM_RATIO) return "rebound_biased";
  return "balanced";
}

export function damperSymptoms(gameId: GameId, samples: readonly SemanticTelemetrySample[]): DamperSymptoms | null {
  if (!gameId) throw new Error("gameId is required for damper symptom analysis");
  const travelByWheel: [number[], number[], number[], number[]] = [[], [], [], []];
  for (const sample of samples) {
    const speed = semanticNumber(sample, "motion.speed");
    if (speed == null || speed <= 5) continue;
    const travel = semanticFixedNumbers(sample, "suspension.norm-suspension-travel", WHEELS);
    if (!travel) continue;
    for (let index = 0; index < WHEELS; index += 1) travelByWheel[index].push(travel[index]);
  }
  if (travelByWheel[0].length < MIN_FRAMES) return null;

  let anyMovement = false;
  for (const travel of travelByWheel) {
    if (percentile(travel, 0.95) - percentile(travel, 0.05) > 0.01) {
      anyMovement = true;
      break;
    }
  }
  if (!anyMovement) return null;

  const corners: DamperCornerSymptom[] = ORDER.map((corner, index) => {
    const travel = travelByWheel[index];
    const p5 = percentile(travel, 0.05);
    const p95 = percentile(travel, 0.95);
    const travelRangePct = (p95 - p5) * 100;
    let bottomingCount = 0;
    let toppingCount = 0;
    const bumpDeltas: number[] = [];
    const reboundDeltas: number[] = [];
    let fastEvents = 0;
    let motionFrames = 0;

    for (let frame = 0; frame < travel.length; frame += 1) {
      if (travel[frame] >= BUMP_STOP) bottomingCount += 1;
      if (travel[frame] <= DROOP_STOP) toppingCount += 1;
      if (frame === 0) continue;
      const delta = travel[frame] - travel[frame - 1];
      if (delta === 0) continue;
      motionFrames += 1;
      if (Math.abs(delta) > FAST_DAMPER_VEL) fastEvents += 1;
      if (delta > 0) bumpDeltas.push(delta);
      else reboundDeltas.push(-delta);
    }
    const bumpVel = mean(bumpDeltas);
    const reboundVel = mean(reboundDeltas);
    return {
      corner,
      meanCompression: mean(travel),
      travelRangePct,
      bottomingPct: (bottomingCount / travel.length) * 100,
      toppingPct: (toppingCount / travel.length) * 100,
      bumpVel,
      reboundVel,
      fastEventPct: motionFrames > 0 ? (fastEvents / motionFrames) * 100 : 0,
      travelUse: travelUse(travelRangePct),
      damperBias: damperBias(bumpVel, reboundVel),
    };
  });

  const frontMinusRearRangePct = (corners[0].travelRangePct + corners[1].travelRangePct - corners[2].travelRangePct - corners[3].travelRangePct) / 2;
  const bottomingCorners = corners.filter((corner) => corner.bottomingPct >= BOTTOMING_PCT).map((corner) => corner.corner);
  const softestCorner = corners.reduce((softest, corner) => (corner.travelRangePct > softest.travelRangePct ? corner : softest)).corner;
  const stiffestCorner = corners.reduce((stiffest, corner) => (corner.travelRangePct < stiffest.travelRangePct ? corner : stiffest)).corner;
  return {
    corners,
    frontMinusRearRangePct,
    bottomingCorners,
    softestCorner,
    stiffestCorner,
  };
}

export function formatDamperSymptoms(d: DamperSymptoms | null): string {
  if (!d) return "Damper/suspension-travel data unavailable for this game.";
  const useWord: Record<TravelUse, string> = {
    stiff: "narrow band (over-stiff/over-damped)",
    optimal: "healthy band",
    soft: "wide band (soft/under-damped)",
  };
  const biasWord: Record<DamperBias, string> = {
    bump_biased: "bump faster than rebound",
    rebound_biased: "rebound faster than bump",
    balanced: "symmetric",
  };
  const lines = d.corners
    .map((corner) => {
      const parts = [
        `travel ${corner.travelRangePct.toFixed(0)}% used (${useWord[corner.travelUse]})`,
        `mean ${(corner.meanCompression * 100).toFixed(0)}% comp`,
        `damper: ${biasWord[corner.damperBias]}`,
        `fast events ${corner.fastEventPct.toFixed(0)}%`,
        corner.bottomingPct >= BOTTOMING_PCT ? `bottoming ${corner.bottomingPct.toFixed(0)}%` : null,
      ].filter(Boolean);
      return `  ${corner.corner} — ${parts.join(", ")}`;
    })
    .join("\n");
  const bottoming = d.bottomingCorners.length > 0 ? d.bottomingCorners.join(", ") : "none";
  return `Dampers (softest ${d.softestCorner}, stiffest ${d.stiffestCorner}; front−rear band ${d.frontMinusRearRangePct.toFixed(0)}%, bottoming: ${bottoming}):
${lines}`;
}
