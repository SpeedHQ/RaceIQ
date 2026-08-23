// Extension field normalization and variable construction.
import {
  SEMANTIC_DEFINITIONS,
  TIRE_IDS,
} from "./semantic-definitions";
import { categoryFor, humanize, slug, unavailable, unitFor, wheelFieldSets } from "./ast-discovery";
import { attachChild } from "./packet-mapping";
import { extensionMetadata, unavailableExtensionSource, unavailableGames } from "./extension-metadata";
import type {
  AvailableLink, CatalogGroup, CatalogVariable, ExtensionFieldSet, FieldInfo, FieldSet, GameId, SourceVariable,
} from "./model";

const NORMALIZED_SEMANTIC_ALIASES: Record<string, string> = {
  Accel: "inputs.throttle",
  Brake: "inputs.brake",
  Clutch: "inputs.clutch",
  FuelCapacity: "fuel.capacity",
  HandBrake: "inputs.handbrake",
  TyreCompound: "tires.tire-compound",
  TimestampMS: "session.timestamp",
  NumCylinders: "engine.cylinder-count",
  Steer: "inputs.steering",
  SurfaceRumbleFL_2: "tires.surface-rumble",
  SurfaceRumbleFR_2: "tires.surface-rumble",
  SurfaceRumbleRL_2: "tires.surface-rumble",
  SurfaceRumbleRR_2: "tires.surface-rumble",
  TireSlipCombinedFL_2: "tires.normalized-tire-slip-angle",
};

function normalizedSemantic(
  set: FieldSet,
): { id: string; parentId: string; label: string } {
  const tire = TIRE_IDS[set.key];
  if (tire) return { id: tire[0], parentId: tire[1], label: tire[2] };
  const category = categoryFor(set.key);
  const id =
    NORMALIZED_SEMANTIC_ALIASES[set.key] ??
    `${category}.${slug(set.key)}`;
  const definition = SEMANTIC_DEFINITIONS[id];
  return {
    id,
    parentId: definition?.parentId ?? category,
    label: definition?.label ?? humanize(set.key),
  };
}

function addSource(
  inventories: Record<GameId, SourceVariable[]>,
  gameId: GameId,
  source: SourceVariable,
): void {
  const existing = inventories[gameId].find((item) => item.path === source.path);
  if (!existing) inventories[gameId].push(source);
}

function extensionFields(
  fields: FieldInfo[],
  prefix: string,
): { path: string; name: string; type: string; description?: string }[] {
  return fields.map((field) => ({
    path: `${prefix}.${field.name}`,
    name: field.name,
    type: field.type,
    description: field.description,
  }));
}

function extensionFieldSets(
  fields: { path: string; name: string; type: string; description?: string }[],
): ExtensionFieldSet[] {
  const byParent = new Map<
    string,
    { path: string; name: string; type: string; description?: string }[]
  >();
  for (const field of fields) {
    const dot = field.path.lastIndexOf(".");
    const parent = dot >= 0 ? field.path.slice(0, dot) : "";
    const list = byParent.get(parent) ?? [];
    list.push(field);
    byParent.set(parent, list);
  }

  const result: ExtensionFieldSet[] = [];
  for (const [parent, children] of byParent) {
    const byName = new Map(children.map((field) => [field.name.split(".").at(-1) ?? field.name, field]));
    const sets = wheelFieldSets([...byName.keys()]);
    for (const set of sets) {
      const members = set.fields.map((name) => byName.get(name)).filter(Boolean) as typeof children;
      const paths = members.map((member) => member.path);
      const parentParts = parent.split(".");
      const contextParts =
        parentParts[0] === "f1"
          ? parentParts.slice(1)
          : parentParts[0] === "iracing"
            ? parentParts.slice(1)
          : parentParts[0] === "acc" && parentParts[1] === "acEvo"
            ? parentParts.slice(2)
            : parentParts[0] === "acc"
              ? parentParts.slice(1)
              : parentParts;
      const context = contextParts.join(".").replaceAll("[]", "");
      result.push({
        key: set.key,
        semanticKey: context ? `${context}.${set.key}` : set.key,
        paths,
        type: members[0]?.type ?? "unknown",
        description: members[0]?.description,
        shape: set.shape,
        ...(set.wheelFields
          ? {
              wheelPaths: Object.fromEntries(
                Object.entries(set.wheelFields).map(([wheel, name]) => [
                  wheel,
                  `${parent}.${name}`,
                ]),
              ),
            }
          : {}),
      });
    }
  }
  return result;
}

function addExtensionVariable(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
  gameId: GameId,
  field: ExtensionFieldSet,
): void {
  const metadata = extensionMetadata(field.paths[0]);
  const alias = metadata?.semanticId;
  const category = categoryFor(field.semanticKey);
  const id = alias ?? `${category}.${slug(field.semanticKey)}`;
  const definition = SEMANTIC_DEFINITIONS[id];
  const unit = metadata?.unit ?? unitFor(field.semanticKey, field.type);
  const sourceDescription =
    metadata?.description ??
    (field.description && field.description.length > 15
      ? field.description
      : `${humanize(field.semanticKey)} source value reported by ${gameId} in ${unit}.`);
  let variable = variables.get(id);

  if (!variable) {
    variable = {
      id,
      ...(definition ?? {
        label: humanize(field.semanticKey),
        description: sourceDescription,
        parentId: category,
        canonicalUnit: unit,
        shape:
          field.shape === "per-wheel"
            ? "per-wheel"
            : field.paths.some((path) => path.includes("[]")) ||
                /\[\]|Array|Record|\{/.test(field.type)
              ? "structured"
              : "scalar",
      }),
      games: unavailableGames(
        "This parser does not expose an equivalent source value.",
      ),
    };
    variables.set(id, variable);
    attachChild(groups, variable.parentId, id);
  }

  const availablePaths = field.paths.filter(
    (path) => !unavailableExtensionSource(gameId, path),
  );
  const unavailablePaths = field.paths.filter((path) =>
    unavailableExtensionSource(gameId, path),
  );
  const existing = variable.games[gameId];
  const sourceValue: AvailableLink["sources"] = field.wheelPaths
    ? Object.fromEntries(
        Object.entries(field.wheelPaths).map(([wheel, path]) => [
          wheel,
          unavailableExtensionSource(gameId, path) ? [] : [path],
        ]),
      )
    : [...availablePaths];
  if (existing.kind === "unavailable") {
    const unavailableSource = unavailablePaths
      .map((path) => unavailableExtensionSource(gameId, path))
      .find(Boolean);
    const f1SectorLayoutPlaceholder =
      gameId === "f1-2025" &&
      field.paths.some((path) =>
        [
          "f1.sector2LapDistanceStart",
          "f1.sector3LapDistanceStart",
        ].includes(path),
      );
    variable.games[gameId] = availablePaths.length === 0 && unavailableSource
      ? unavailable(unavailableSource.reason, unavailableSource.description)
      : f1SectorLayoutPlaceholder
        ? unavailable(
            "parser-placeholder",
            "F1 2025 packet parser reserves this field but source packet does not provide sector boundary distances.",
          )
      : {
          kind: metadata?.kind ?? "direct",
          nativeUnit: unit,
          sources: sourceValue,
          freshness:
            metadata?.freshness ??
            (/setup|version|name|radius/i.test(field.paths.join(" "))
              ? "static"
              : "continuous"),
          ...(metadata?.normalization
            ? { normalization: metadata.normalization }
            : {}),
          description: `${gameId} parser exposes ${field.paths.length} linked field${field.paths.length === 1 ? "" : "s"}.`,
        };
  } else if (Array.isArray(existing.sources)) {
    for (const sourcePath of availablePaths) {
      if (!existing.sources.includes(sourcePath)) existing.sources.push(sourcePath);
    }
  }

  for (const sourcePath of field.paths) {
    addSource(inventories, gameId, {
      path: sourcePath,
      label: humanize(sourcePath.split(".").at(-1) ?? sourcePath),
      unit,
      dataType: field.type,
      ...(!/\[\]|Array|Record|\{/.test(field.type) ? { count: 1 } : {}),
      description:
        unavailableExtensionSource(gameId, sourcePath)?.description ??
        sourceDescription,
      semanticId: id,
      sourceKind: "extension",
      recordedByRaceIQ: true,
      retention: "exact",
    });
  }
}

export { NORMALIZED_SEMANTIC_ALIASES, normalizedSemantic, addSource, extensionFields, extensionFieldSets, addExtensionVariable };
