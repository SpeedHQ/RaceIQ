import type { GameId } from "@shared/games/ids";
import { IRACING_SETUP_INFO_FIELDS } from "@shared/games/iracing/session-info/catalog";
import {
  SETUP_FILE_SECTION_DEFINITIONS,
  SETUP_FILE_SOURCE_DEFINITIONS,
} from "./file-source-mappings";
import { SETUP_CONCEPT_DEFINITIONS, type SetupConceptId } from "./concepts";
import { SETUP_GROUP_DEFINITIONS, type SetupConceptDefinition, type SetupFieldCardinality } from "./groups";

export interface SetupCatalogVariable extends SetupConceptDefinition {
  id: SetupConceptId;
}

export interface SetupCatalogSourceVariable {
  path: string;
  label: string;
  description: string;
  unit: string;
  semanticId: SetupConceptId;
  sourceKind: "setup-file" | "iracing-session-info";
  editable: boolean;
  cardinality?: SetupFieldCardinality;
}

export interface SetupCatalogData {
  groups: typeof SETUP_GROUP_DEFINITIONS;
  variables: readonly SetupCatalogVariable[];
  sources: Partial<Record<GameId, readonly SetupCatalogSourceVariable[]>>;
}

function setupFileSources(gameId: "acc" | "ac-evo"): readonly SetupCatalogSourceVariable[] {
  return SETUP_FILE_SOURCE_DEFINITIONS.flatMap((field) => {
    const section = SETUP_FILE_SECTION_DEFINITIONS.find((candidate) =>
      field.path.startsWith(`${candidate.id}.`),
    );
    if (!section) {
      throw new Error(`Setup file source ${field.path} has no catalogued section`);
    }
    if (!section.games.some((supportedGame) => supportedGame === gameId)) return [];
    return [
      {
        path: field.path,
        label: field.label,
        description: field.description,
        unit: field.nativeUnit,
        semanticId: field.semanticId,
        sourceKind: "setup-file" as const,
        editable: true,
        cardinality: field.cardinality,
      },
    ];
  });
}

function iracingSetupSources(): readonly SetupCatalogSourceVariable[] {
  return IRACING_SETUP_INFO_FIELDS.map((field) => {
    const semanticId = field.semanticId;
    if (!semanticId || !(semanticId in SETUP_CONCEPT_DEFINITIONS)) {
      throw new Error(`iRacing setup source ${field.path} has no catalogued semantic`);
    }
    return {
      path: field.path,
      label: field.label,
      description: field.description,
      unit: field.unit,
      semanticId: semanticId as SetupConceptId,
      sourceKind: "iracing-session-info",
      editable: false,
    };
  });
}

export const SETUP_CATALOG: SetupCatalogData = {
  groups: SETUP_GROUP_DEFINITIONS,
  variables: Object.entries(SETUP_CONCEPT_DEFINITIONS).map(([id, definition]) => ({
    id: id as SetupConceptId,
    ...definition,
  })),
  sources: {
    acc: setupFileSources("acc"),
    "ac-evo": setupFileSources("ac-evo"),
    iracing: iracingSetupSources(),
  },
};
