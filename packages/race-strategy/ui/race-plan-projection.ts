import type { GameId } from "@raceiq/shared/games/ids";
import type { RacePlan, RacePlanBaseline, RacePlanInput, RacePlanStintInput } from "@raceiq/shared/racing/live/race-plan";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";

type PlanIdentity = Pick<RacePlanInput, "gameId" | "carId" | "trackId" | "pi">;

export function isRacePlanApplicable(plan: RacePlan | null, identity: { gameId: GameId; carId: string | null; trackId: string | null; pi: number | null }): plan is RacePlan {
  return plan != null && identity.carId != null && identity.trackId != null &&
    plan.gameId === identity.gameId && plan.carId === identity.carId && plan.trackId === identity.trackId &&
    (identity.gameId !== "fm-2023" || identity.pi != null && plan.pi === identity.pi);
}

export function racePlanProgress(plan: RacePlan, currentLap: number | null) {
  const validLap = currentLap != null && Number.isFinite(currentLap) && currentLap >= 1;
  const index = validLap ? plan.stints.findIndex((stint) => currentLap <= stint.endLap) : -1;
  return { index, currentStint: plan.stints[index] ?? null, nextStint: index >= 0 ? plan.stints[index + 1] ?? null : null, finished: validLap && currentLap > plan.totalLaps };
}

export function projectRacePlanStint(stint: RacePlanStintInput, previousEnd: number, plan: PlanIdentity & Pick<RacePlanInput, "fuelUnit">, evidence: StintSummary | RacePlanBaseline | null, thresholds: (compound: string) => TireThresholds) {
  const laps = stint.endLap - previousEnd;
  const identityMatches = evidence != null && evidence.gameId === plan.gameId && evidence.carId === plan.carId && evidence.trackId === plan.trackId && (plan.gameId !== "fm-2023" || evidence.pi === plan.pi);
  const rate = evidence?.fuel.value;
  const expectedFuelUnit = plan.fuelUnit === "L" ? "L/lap" : "tankFraction/lap";
  const compatibleFuel = identityMatches && evidence != null && evidence.fuelUnit === plan.fuelUnit && evidence.fuel.unit === expectedFuelUnit && evidence.compatibility.fuelSemanticVersion != null && rate != null && rate >= 0;
  const consumed = compatibleFuel && laps > 0 && Number.isFinite(rate) ? rate! * laps : null;
  const fuelEnd = consumed != null && stint.startFuel != null ? stint.startFuel - consumed : null;
  const energy = evidence?.virtualEnergy;
  const compatibleEnergy = identityMatches && plan.gameId === "lmu" && evidence?.compatibility.virtualEnergySemanticVersion != null &&
    energy?.unit === "energyFraction/lap" && energy.eligibleLaps > 0 && energy.value != null && Number.isFinite(energy.value) && energy.value >= 0 &&
    stint.compounds.every((compound, index) => compound === evidence?.compounds[index]);
  const virtualEnergyUsed = compatibleEnergy && laps > 0 ? energy!.value! * laps : null;
  const tires = stint.compounds.map((compound, index) => {
    const tire = evidence?.tires[index];
    const compoundKey = compound?.trim().toLowerCase();
    const knownCompound = compoundKey != null && compoundKey !== "" && compoundKey !== "default" && compoundKey !== "unknown";
    const compatible = identityMatches && evidence != null && knownCompound && compound === evidence.compounds[index] && evidence.compatibility.tireSemanticVersions[index] != null && tire?.unit === "wearFraction/lap" && tire.eligibleLaps > 0 && ("sources" in evidence || tire.source != null) && tire.value != null && Number.isFinite(tire.value) && tire.value >= 0;
    const wear = compatible ? tire!.value! : null;
    const limit = thresholds(compound ?? "default");
    return {
      health: wear != null && laps > 0 ? Math.max(0, Math.min(100, 100 * (1 - wear * laps))) : null,
      cliffPct: limit.cliffPct,
      deadPct: limit.deadPct,
      cliffLaps: wear != null && wear > 0 ? (1 - limit.cliffPct / 100) / wear : null,
      deadLaps: wear != null && wear > 0 ? (1 - limit.deadPct / 100) / wear : null,
      zeroWear: wear === 0,
    };
  });
  return { laps, consumed, fuelEnd, fuelWarning: fuelEnd != null && fuelEnd < 0, virtualEnergyUsed, tires };
}
