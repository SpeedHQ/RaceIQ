import type { GameId } from "@shared/games/ids";
import { SETUP_CATALOG, type SetupCatalogSourceVariable, type SetupCatalogVariable } from "./data";

const variablesById = new Map<string, SetupCatalogVariable>(
  SETUP_CATALOG.variables.map((variable) => [variable.id, variable]),
);

export function getSetupCatalogVariable(id: string): SetupCatalogVariable {
  const variable = variablesById.get(id);
  if (!variable) throw new Error(`Unknown setup catalog variable ${id}`);
  return variable;
}

export function getSetupCatalogSources(
  gameId: GameId,
): readonly SetupCatalogSourceVariable[] {
  return SETUP_CATALOG.sources[gameId] ?? [];
}
