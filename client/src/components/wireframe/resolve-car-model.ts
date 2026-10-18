import type { GameId } from "@raceiq/shared/games/ids";
import { type CarModelEnrichment, DEMO_CAR, F1_CAR, getCarModel, getLMUClassCarModel } from "../../data/car-models";

export interface ResolvedCarModel {
  model: CarModelEnrichment & { hasModel: boolean };
  label: "exact" | "generic";
}

export function resolveCarModel(
  gameId: GameId,
  carId: string | undefined,
  options?: { lmuCarClass?: string; carModel?: CarModelEnrichment & { hasModel: boolean } },
): CarModelEnrichment & { hasModel: boolean } {
  return resolveCarModelSelection(gameId, carId, options).model;
}

/** Exposes fallback identity so Spectate can label generic geometry truthfully. */
export function resolveCarModelSelection(gameId: GameId, carId: string | undefined, options?: { lmuCarClass?: string; carModel?: CarModelEnrichment & { hasModel: boolean } }): ResolvedCarModel {
  if (options?.carModel) return { model: options.carModel, label: "exact" };
  // F1 and LMU currently share representative class/regulation geometry, not
  // per-vehicle models; callers must identify these as generic.
  if (gameId === "f1-2025") return { model: F1_CAR, label: "generic" };
  if (gameId === "lmu") return { model: getLMUClassCarModel(options?.lmuCarClass), label: "generic" };
  if (carId == null) return { model: { ...DEMO_CAR }, label: "generic" };
  const perCar = getCarModel(carId);
  return perCar.hasModel ? { model: perCar, label: "exact" } : { model: DEMO_CAR, label: "generic" };
}
