// Setup-file variables and derived/normalized links.
import type { getSchemaForGame } from "../../shared/racing/setups/schema";
import { SETUP_FILE_SOURCE_MAPPINGS } from "../../shared/racing/setups/catalog/file-source-mappings";
import { SEMANTIC_DEFINITIONS } from "./semantic-definitions";
import { addSource } from "./extension-field-mapping";
import { unavailableGames } from "./extension-metadata";
import { attachChild } from "./packet-mapping";
import type { AvailableLink, CatalogGroup, CatalogVariable, GameId, GameLink, SourceVariable } from "./model";

function addSetupFileVariable(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
  gameId: "acc" | "ac-evo",
  field: ReturnType<typeof getSchemaForGame>[number]["fields"][number],
): void {
  const mapping = SETUP_FILE_SOURCE_MAPPINGS[field.path];
  if (!mapping) {
    throw new Error(`Missing setup-file semantic mapping for ${field.path}`);
  }
  const definition = SEMANTIC_DEFINITIONS[mapping.semanticId];
  if (!definition) {
    throw new Error(`Missing setup semantic definition ${mapping.semanticId}`);
  }

  let variable = variables.get(mapping.semanticId);
  if (!variable) {
    variable = {
      id: mapping.semanticId,
      ...definition,
      games: unavailableGames(
        "No equivalent setup source is currently identified for this game.",
      ),
    };
    variables.set(mapping.semanticId, variable);
    attachChild(groups, definition.parentId, mapping.semanticId);
  }

  const sourcePath = `${gameId === "acc" ? "ACC" : "ACEvo"}.SetupFile.${field.path}`;
  const existing = variable.games[gameId];
  if (existing.kind === "unavailable") {
    variable.games[gameId] = {
      kind: mapping.kind ?? "direct",
      nativeUnit: mapping.nativeUnit,
      sources: [sourcePath],
      freshness: "static",
      ...(mapping.normalization
        ? { normalization: mapping.normalization }
        : {}),
      description: `${gameId} setup file exposes this ${field.arity} value.`,
    };
  } else if (Array.isArray(existing.sources)) {
    if (!existing.sources.includes(sourcePath)) {
      existing.sources.push(sourcePath);
    }
  }

  addSource(inventories, gameId, {
    path: sourcePath,
    label: field.label,
    unit: mapping.nativeUnit,
    dataType: "setup-value",
    count: 1,
    description: `${field.label} from ${gameId} setup file${field.hint ? `; ${field.hint}` : ""}.`,
    semanticId: mapping.semanticId,
    sourceKind: "setup",
    recordedByRaceIQ: false,
    retention: "not-recorded",
  });
}

function addDefinedVariable(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  id: string,
  games: Record<GameId, GameLink>,
): void {
  if (variables.has(id)) return;
  const definition = SEMANTIC_DEFINITIONS[id];
  if (!definition) throw new Error(`Missing semantic definition ${id}`);
  variables.set(id, {
    id,
    ...definition,
    games,
  });
  attachChild(groups, definition.parentId, id);
}

function derivedLink(
  nativeUnit: string,
  sources: string[],
  normalization: string,
  description: string,
  freshness: AvailableLink["freshness"] = "continuous",
): AvailableLink {
  return {
    kind: "derived",
    nativeUnit,
    sources,
    freshness,
    normalization,
    description,
  };
}

function normalizedLink(
  nativeUnit: string,
  sources: string[],
  normalization: string,
  description: string,
  freshness: AvailableLink["freshness"] = "continuous",
): AvailableLink {
  return {
    kind: "normalized",
    nativeUnit,
    sources,
    freshness,
    normalization,
    description,
  };
}

export { addSetupFileVariable, addDefinedVariable, derivedLink, normalizedLink };
