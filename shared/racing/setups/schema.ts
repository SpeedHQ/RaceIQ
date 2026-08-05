import type { GameId } from "@shared/games/ids";
import {
  SETUP_FILE_SECTION_DEFINITIONS,
  SETUP_FILE_SOURCE_DEFINITIONS,
  SETUP_FORM_TAB_ORDER,
  type SetupFileSectionId,
  type SetupFileSource,
} from "./catalog/file-source-mappings";
import type {
  SetupFileGameId,
  SetupFormTab,
} from "./catalog/groups";

export { SETUP_FORM_TAB_ORDER };

// Kunos stores ACC/EVO setups as nested JSON with in-game "click" values.
// Catalog entries own source paths, labels, descriptions, units, semantics,
// and cardinality. Form code receives those exact entries instead of rebuilding
// dotted paths or parallel label/arity tables.

export type FieldDef = SetupFileSource;

export interface SectionDef {
  key: SetupFileSectionId;
  label: string;
  description: string;
  tab: SetupFormTab;
  fields: readonly FieldDef[];
}

function supportsGame(
  games: readonly SetupFileGameId[],
  gameId: SetupFileGameId,
): boolean {
  return games.includes(gameId);
}

function compileSchema(gameId: SetupFileGameId): readonly SectionDef[] {
  return SETUP_FILE_SECTION_DEFINITIONS.filter((section) =>
    supportsGame(section.games, gameId),
  ).map((section) => ({
    key: section.id,
    label: section.label,
    description: section.description,
    tab: section.tab,
    fields: SETUP_FILE_SOURCE_DEFINITIONS.filter((field) =>
      field.path.startsWith(`${section.id}.`),
    ),
  }));
}

const SETUP_SCHEMAS = {
  acc: compileSchema("acc"),
  "ac-evo": compileSchema("ac-evo"),
} as const satisfies Record<SetupFileGameId, readonly SectionDef[]>;

const EMPTY_SETUP_SCHEMA: readonly SectionDef[] = [];

export function getSchemaForGame(gameId: GameId): readonly SectionDef[] {
  if (gameId === "acc" || gameId === "ac-evo") {
    return SETUP_SCHEMAS[gameId];
  }
  return EMPTY_SETUP_SCHEMA;
}

function readPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function readSetupField(
  obj: unknown,
  field: FieldDef,
): unknown {
  return readPath(obj, field.path);
}

export function readSetupSection(
  obj: unknown,
  section: SectionDef,
): unknown {
  return readPath(obj, section.key);
}

export function writeSetupField(
  obj: Record<string, unknown>,
  field: FieldDef,
  value: unknown,
): void {
  const segments = field.path.split(".");
  let current: Record<string, unknown> = obj;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    const next = current[segment];
    if (next == null || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}
