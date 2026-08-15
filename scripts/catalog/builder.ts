import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CATALOG_FORMAT,
  CATALOG_SCHEMA_VERSION,
  GAME_IDS,
  GENERATOR_NAME,
  IRACING_DIAGNOSTIC,
  IRACING_SESSION_INFO_CAPTURE_DIRECTORY,
  IRACING_SESSION_INFO_SOURCE_FILES,
  PACKAGE_VERSION,
  PARSER_FILES,
  ROOT,
  TELEMETRY_TYPE_SOURCE_FILES,
} from "./model";
import {
  IRACING_SESSION_INFO_CATALOG_FIELDS,
} from "../../shared/games/iracing/session-info/catalog";
import { getSchemaForGame } from "../../shared/racing/setups/schema";
import {
  assertIRacingSessionInfoCaptureCoverage,
  readIRacingSessionInfoCaptures,
} from "./iracing-session-info-capture";
import {
  ast,
  categoryFor,
  humanize,
  interfaceFields,
  interfaceLeafFields,
  parserOutput,
  unitFor,
  wheelFieldSets,
  slug,
} from "./ast-discovery";
import {
  DESCRIPTION_OVERRIDES,
  SEMANTIC_DEFINITIONS,
  TIRE_IDS,
} from "./semantic-definitions";
import {
  attachChild,
  ensureCategoryGroups,
  nativeFuelUnit,
  packetGameLink,
} from "./packet-mapping";
import {
  IRACING_SDK_ALIASES,
  addExtensionVariable,
  addIRacingRawYamlSource,
  addIRacingYamlField,
  addSetupFileVariable,
  canonicalIRacingUnit,
  generalizeIRacingDescription,
  iRacingFreshness,
  inferredIRacingUnit,
  extensionFieldSets,
  extensionFields,
  unavailableGames,
  normalizedSemantic,
  addSource,
} from "./extension-mapping";
import {
  addCrossSourceProjections,
  addSectorDerivedVariables,
  contentHash,
  enrichCatalogContracts,
  telemetryCatalogSourceHash,
} from "./contract-enrichment";
import type {
  AvailableLink,
  BuiltTelemetryCatalog,
  CatalogGroup,
  CatalogMetadata,
  CatalogVariable,
  GameId,
  GameLink,
  ParserOutput,
  SourceVariable,
} from "./model";
// Orchestrates source discovery and catalog assembly.
const CATALOG_GENERATOR_SOURCE_FILES = [
  "scripts/catalog/ast-discovery.ts",
  "scripts/catalog/builder.ts",
  "scripts/catalog/cli.ts",
  "scripts/catalog/contract-enrichment.ts",
  "scripts/catalog/contract-inference.ts",
  "scripts/catalog/contract-provenance.ts",
  "scripts/catalog/derived-projections.ts",
  "scripts/catalog/extension-field-mapping.ts",
  "scripts/catalog/extension-mapping.ts",
  "scripts/catalog/extension-metadata.ts",
  "scripts/catalog/generate-telemetry-catalog.ts",
  "scripts/catalog/iracing-mapping.ts",
  "scripts/catalog/iracing-session-info-capture.ts",
  "scripts/catalog/model.ts",
  "scripts/catalog/packet-mapping.ts",
  "scripts/catalog/rendering.ts",
  "scripts/catalog/semantic-definitions-competitor.ts",
  "scripts/catalog/semantic-definitions-extended.ts",
  "scripts/catalog/semantic-definitions-live.ts",
  "scripts/catalog/semantic-definitions.ts",
  "scripts/catalog/semantic-metadata.ts",
  "scripts/catalog/setup-link-mapping.ts",
] as const;

export async function buildTelemetryCatalog(): Promise<BuiltTelemetryCatalog> {
  const iracingSessionInfoCaptures =
    await readIRacingSessionInfoCaptures(
      IRACING_SESSION_INFO_CAPTURE_DIRECTORY,
    );
  assertIRacingSessionInfoCaptureCoverage(
    iracingSessionInfoCaptures,
    IRACING_SESSION_INFO_CATALOG_FIELDS,
  );
  const iracingSessionInfoCaptureArtifacts =
    iracingSessionInfoCaptures.map(
      ({ fileName }) =>
        `data/diagnostics/iracing-session-info/${fileName}`,
    );
  const [
    typesSource,
    f1TypesSource,
    kunosTypesSource,
    iracingTypesSource,
  ] = await Promise.all(
    TELEMETRY_TYPE_SOURCE_FILES.map(async (path) =>
      (await readFile(resolve(ROOT, path), "utf8")).replace(/\r\n?/g, "\n"),
    ),
  );
  const typesTree = ast(typesSource);
  const f1TypesTree = ast(f1TypesSource);
  const kunosTypesTree = ast(kunosTypesSource);
  const iracingTypesTree = ast(iracingTypesSource);
  const packetFields = interfaceFields(
    typesSource,
    typesTree,
    "TelemetryPacket",
  ).filter((field) => !["gameId", "f1", "acc", "iracing"].includes(field.name));
  const packetFieldNames = packetFields.map((field) => field.name);
  const packetSets = wheelFieldSets(packetFieldNames);

  const parserOutputs = Object.fromEntries(
    await Promise.all(
      GAME_IDS.map(async (gameId) => [gameId, await parserOutput(gameId)]),
    ),
  ) as Record<GameId, ParserOutput>;

  const groups = new Map<string, CatalogGroup>();
  const variables = new Map<string, CatalogVariable>();
  ensureCategoryGroups(groups);

  const inventories: Record<GameId, SourceVariable[]> = {
    "fm-2023": [],
    "f1-2025": [],
    acc: [],
    "ac-evo": [],
    iracing: [],
  };
  for (const set of packetSets) {
    const semantic = normalizedSemantic(set);
    const semanticDefinition = SEMANTIC_DEFINITIONS[semantic.id];
    const fieldInfo = packetFields.find((field) => field.name === set.fields[0]);
    const inferredUnit =
      set.key === "Fuel"
        ? "game-native"
        : unitFor(set.key, fieldInfo?.type);
    const unit = semanticDefinition?.canonicalUnit ?? inferredUnit;
    const description =
      semanticDefinition?.description ??
      (TIRE_IDS[set.key]?.[0] === "tire.temperature.average"
        ? "Common one-value-per-tire temperature. Mapping may be native or a documented average of detailed channels."
        : DESCRIPTION_OVERRIDES[set.key] ??
          fieldInfo?.description ??
          `${humanize(set.key)} reported by normalized RaceIQ telemetry.`);
    const gameLinks = Object.fromEntries(
      GAME_IDS.map((gameId) => {
        const link = packetGameLink(
          gameId,
          set,
          parserOutputs[gameId],
          set.key === "Fuel" ? nativeFuelUnit(gameId) : unit,
        );
        return [gameId, link];
      }),
    ) as Record<GameId, GameLink>;

    const variable: CatalogVariable = {
      id: semantic.id,
      label: semantic.label,
      description,
      parentId: semanticDefinition?.parentId ?? semantic.parentId,
      canonicalUnit: unit,
      shape: semanticDefinition?.shape ?? set.shape,
      packetFields: set.fields,
      games: gameLinks,
    };
    const existingPacketFields = variables.get(variable.id)?.packetFields ?? [];
    variable.packetFields = [
      ...new Set([...existingPacketFields, ...(variable.packetFields ?? [])]),
    ];
    variables.set(variable.id, variable);
    attachChild(groups, variable.parentId, variable.id);

    for (const gameId of GAME_IDS) {
      for (const field of set.fields) {
        if (!parserOutputs[gameId].properties.has(field)) continue;
        addSource(inventories, gameId, {
          path: `TelemetryPacket.${field}`,
          label: humanize(field),
          unit:
            gameId === "fm-2023" && set.key.startsWith("TireTemp")
              ? "°F"
              : unit,
          dataType: fieldInfo?.type ?? "unknown",
          count: 1,
          description:
            DESCRIPTION_OVERRIDES[set.key] ??
            fieldInfo?.description ??
            `${humanize(field)} emitted by ${gameId} parser.`,
          semanticId:
            gameId === "fm-2023" && set.key === "TireSlipAngle"
              ? "tires.normalized-tire-slip-angle"
              : variable.id,
          sourceKind: "packet",
          recordedByRaceIQ: true,
          retention: "exact",
        });
      }
    }
  }

  const f1Fields = extensionFieldSets(extensionFields(
    interfaceLeafFields(f1TypesSource, f1TypesTree, "F1ExtendedData"),
    "f1",
  ));
  const accFields = extensionFieldSets(extensionFields(
    interfaceLeafFields(
      kunosTypesSource,
      kunosTypesTree,
      "KunosExtendedData",
      new Set(["AcEvoExtendedData"]),
    ).filter(
      (field) => field.name !== "acEvo",
    ),
    "acc",
  ));
  const acEvoFields = extensionFieldSets(extensionFields(
    interfaceLeafFields(
      kunosTypesSource,
      kunosTypesTree,
      "AcEvoExtendedData",
    ),
    "acc.acEvo",
  ));
  const iracingFields = extensionFieldSets(extensionFields(
    interfaceLeafFields(
      iracingTypesSource,
      iracingTypesTree,
      "IRacingExtendedData",
    ),
    "iracing",
  ));

  for (const field of f1Fields) {
    addExtensionVariable(variables, groups, inventories, "f1-2025", field);
  }
  for (const field of accFields) {
    addExtensionVariable(variables, groups, inventories, "acc", field);
    addExtensionVariable(variables, groups, inventories, "ac-evo", field);
  }
  for (const field of acEvoFields) {
    addExtensionVariable(variables, groups, inventories, "ac-evo", field);
  }
  for (const field of iracingFields) {
    addExtensionVariable(variables, groups, inventories, "iracing", field);
  }
  for (const gameId of ["acc", "ac-evo"] as const) {
    for (const section of getSchemaForGame(gameId)) {
      for (const field of section.fields) {
        addSetupFileVariable(
          variables,
          groups,
          inventories,
          gameId,
          field,
        );
      }
    }
  }

  const diagnostic = JSON.parse(await readFile(IRACING_DIAGNOSTIC, "utf8")) as {
    format: string;
    variables: {
      name: string;
      type: string;
      count: number;
      unit: string;
      description: string;
      recordedByRaceIQ?: boolean;
    }[];
    raceIQSelected?: { present?: string[] };
  };
  if (diagnostic.format !== "raceiq-iracing-all-vars-v1") {
    throw new Error(`Unexpected iRacing diagnostic format ${diagnostic.format}`);
  }
  const selected = new Set(diagnostic.raceIQSelected?.present ?? []);
  const existingIRacingSources = new Map<string, string>();
  for (const variable of variables.values()) {
    const link = variable.games.iracing;
    if (link.kind === "unavailable") continue;
    const sources = Array.isArray(link.sources)
      ? link.sources
      : Object.values(link.sources).flat();
    for (const source of sources) {
      if (source.startsWith("iRacing.")) {
        existingIRacingSources.set(source.slice("iRacing.".length), variable.id);
      }
    }
  }

  const rawByName = new Map(
    diagnostic.variables.map((variable) => [variable.name, variable]),
  );
  const consumed = new Set<string>();
  const wheels = ["LF", "RF", "LR", "RR"] as const;

  for (const raw of diagnostic.variables) {
    if (consumed.has(raw.name)) continue;
    const existingSemantic =
      IRACING_SDK_ALIASES[raw.name] ??
      existingIRacingSources.get(raw.name);
    if (existingSemantic) {
      if (!variables.has(existingSemantic)) {
        const definition = SEMANTIC_DEFINITIONS[existingSemantic];
        if (!definition) {
          throw new Error(
            `Missing semantic definition for iRacing SDK alias ${raw.name}`,
          );
        }
        variables.set(existingSemantic, {
          id: existingSemantic,
          ...definition,
          games: unavailableGames(
            "No equivalent source value is currently identified for this parser.",
          ),
        });
        attachChild(groups, definition.parentId, existingSemantic);
      }
      const semantic = variables.get(existingSemantic)!;
      const link = semantic.games.iracing;
      const sdkSource = `iRacing.${raw.name}`;
      const fuelPercentFraction = raw.name === "FuelLevelPct";
      const lapFraction = raw.name === "LapDistPct";
      const pitRoadBoolean = raw.name === "CarIdxOnPitRoad";
      if (link.kind === "unavailable") {
        const nativeUnit = inferredIRacingUnit(raw, semantic);
        const needsUnitNormalization =
          fuelPercentFraction ||
          lapFraction ||
          pitRoadBoolean ||
          canonicalIRacingUnit(nativeUnit) !== semantic.canonicalUnit;
        semantic.games.iracing = {
          kind: needsUnitNormalization ? "normalized" : "direct",
          nativeUnit,
          sources: [sdkSource],
          freshness: iRacingFreshness(raw.name),
          ...(needsUnitNormalization
            ? {
                normalization: fuelPercentFraction
                  ? "fraction * 100"
                  : lapFraction
                    ? "retain SDK 0-1 value as lap fraction"
                    : pitRoadBoolean
                      ? "true = on pit road; false = not on pit road"
                      : `convert ${nativeUnit} to ${semantic.canonicalUnit}`,
              }
            : {}),
          description: "Native iRacing SDK variable linked to shared semantic value.",
        };
      } else if (Array.isArray(link.sources) && !link.sources.includes(sdkSource)) {
        link.sources.push(sdkSource);
        if (lapFraction) {
          link.kind = "normalized";
          link.nativeUnit = "fraction";
          link.normalization = "clamp SDK 0-1 lap distance to 0-1 fraction";
        }
      }
      consumed.add(raw.name);
      addSource(inventories, "iracing", {
        path: raw.name,
        label: humanize(raw.name),
        unit: inferredIRacingUnit(raw, semantic),
        dataType: raw.type,
        count: raw.count,
        description: raw.description,
        semanticId: existingSemantic,
        sourceKind: "sdk",
        recordedByRaceIQ: selected.has(raw.name),
        retention: selected.has(raw.name) ? "exact" : "not-recorded",
      });
      continue;
    }

    const corner = raw.name.match(/^(LF|RF|LR|RR)(.+)$/);
    let members = [raw];
    let semanticName = raw.name;
    let shape: CatalogVariable["shape"] =
      raw.count > 1 ? "array" : "scalar";
    let sourceShape: AvailableLink["sources"] = [`iRacing.${raw.name}`];
    if (corner) {
      const suffix = corner[2];
      const candidates = wheels.map((wheel) => rawByName.get(`${wheel}${suffix}`));
      if (candidates.every(Boolean)) {
        members = candidates as typeof diagnostic.variables;
        semanticName = suffix;
        shape = "per-wheel";
        sourceShape = Object.fromEntries(
          wheels.map((wheel, index) => [
            wheel,
            [`iRacing.${members[index].name}`],
          ]),
        );
      }
    }
    for (const member of members) consumed.add(member.name);

    const category = categoryFor(`${semanticName} ${raw.description}`);
    const id = `${category}.${slug(semanticName)}`;
    const description = generalizeIRacingDescription(raw.description);
    const unit = inferredIRacingUnit(raw);
    const canonicalUnit = canonicalIRacingUnit(unit);
    const definition = SEMANTIC_DEFINITIONS[id];
    let variable = variables.get(id);
    if (!variable) {
      variable = {
        id,
        label: definition?.label ?? humanize(semanticName),
        description: definition?.description ?? description,
        parentId: definition?.parentId ?? category,
        canonicalUnit: definition?.canonicalUnit ?? canonicalUnit,
        shape: definition?.shape ?? shape,
        games: unavailableGames(
          "No equivalent source variable is currently identified for this parser.",
        ),
      };
      variables.set(id, variable);
      attachChild(groups, variable.parentId, id);
    }

    const existing = variable.games.iracing;
    if (existing.kind === "unavailable") {
      const needsUnitNormalization = unit !== variable.canonicalUnit;
      variable.games.iracing = {
        kind: needsUnitNormalization ? "normalized" : "direct",
        nativeUnit: unit,
        sources: sourceShape,
        freshness: iRacingFreshness(raw.name),
        ...(needsUnitNormalization
          ? {
              normalization:
                canonicalIRacingUnit(unit) === variable.canonicalUnit
                  ? `normalize unit notation ${unit} to ${variable.canonicalUnit}`
                  : `convert ${unit} to ${variable.canonicalUnit}`,
            }
          : {}),
        description: members.every((member) => selected.has(member.name))
          ? "Native iRacing SDK source recorded by RaceIQ."
          : "Native iRacing SDK source; catalogued but not selected in current RaceIQ source frame.",
      };
    } else if (Array.isArray(existing.sources) && Array.isArray(sourceShape)) {
      for (const source of sourceShape) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      }
    } else if (!Array.isArray(existing.sources) && !Array.isArray(sourceShape)) {
      for (const [key, sources] of Object.entries(sourceShape)) {
        const target = existing.sources[key] ?? [];
        for (const source of sources) {
          if (!target.includes(source)) target.push(source);
        }
        existing.sources[key] = target;
      }
    } else {
      const existingSources = Array.isArray(existing.sources)
        ? existing.sources
        : Object.values(existing.sources).flat();
      const newSources = Array.isArray(sourceShape)
        ? sourceShape
        : Object.values(sourceShape).flat();
      existing.sources = [...new Set([...existingSources, ...newSources])];
    }
    for (const member of members) {
      addSource(inventories, "iracing", {
        path: member.name,
        label: humanize(member.name),
        unit: inferredIRacingUnit(member, variable),
        dataType: member.type,
        count: member.count,
        description: member.description,
        semanticId: id,
        sourceKind: "sdk",
        recordedByRaceIQ: selected.has(member.name),
        retention: selected.has(member.name) ? "exact" : "not-recorded",
      });
    }
  }
  addIRacingRawYamlSource(variables, groups, inventories);

  for (const field of IRACING_SESSION_INFO_CATALOG_FIELDS) {
    addIRacingYamlField(variables, groups, inventories, field);
  }

  addCrossSourceProjections(variables, groups);
  addSectorDerivedVariables(variables, groups);

  for (const group of groups.values()) {
    if (group.parentId) attachChild(groups, group.parentId, group.id);
    group.children.sort();
  }
  for (const gameId of GAME_IDS) {
    inventories[gameId].sort((a, b) => a.path.localeCompare(b.path));
  }

  const sourceCounts = Object.fromEntries(
    GAME_IDS.map((gameId) => [
      gameId,
      {
        total: inventories[gameId].length,
        packet: inventories[gameId].filter((item) => item.sourceKind === "packet").length,
        extension: inventories[gameId].filter((item) => item.sourceKind === "extension").length,
        sdk: inventories[gameId].filter((item) => item.sourceKind === "sdk").length,
        yaml: inventories[gameId].filter((item) => item.sourceKind === "yaml").length,
        setup: inventories[gameId].filter((item) => item.sourceKind === "setup").length,
        recorded: inventories[gameId].filter((item) => item.recordedByRaceIQ).length,
      },
    ]),
  ) as BuiltTelemetryCatalog["coverage"]["sourceCounts"];
  const provenanceArtifacts = [
    ...new Set([
      ...CATALOG_GENERATOR_SOURCE_FILES,
      ...IRACING_SESSION_INFO_SOURCE_FILES,
      ...TELEMETRY_TYPE_SOURCE_FILES,
      "shared/racing/setups/schema.ts",
      ...Object.values(PARSER_FILES),
    ]),
  ];
  const provenanceCommits = Object.fromEntries(
    await Promise.all(
      provenanceArtifacts.map(async (artifact) => [
        artifact,
        telemetryCatalogSourceHash(
          await readFile(resolve(ROOT, artifact), "utf8"),
        ),
      ]),
    ),
  );
  const generatorCommit = telemetryCatalogSourceHash(
    (
      await Promise.all(
        CATALOG_GENERATOR_SOURCE_FILES.map((artifact) =>
          readFile(resolve(ROOT, artifact), "utf8"),
        ),
      )
    ).join("\n"),
  );
  provenanceCommits["scripts/catalog/generate-telemetry-catalog.ts"] =
    generatorCommit;
  if (!generatorCommit) {
    throw new Error("Missing telemetry catalog generator provenance");
  }
  enrichCatalogContracts(variables, inventories, provenanceCommits);

  const metadataWithoutHash: Omit<CatalogMetadata, "contentHash"> = {
    catalogVersion: PACKAGE_VERSION,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generator: {
      name: GENERATOR_NAME,
      version: PACKAGE_VERSION,
      commit: generatorCommit,
    },
    // Reproducible-build timestamp: intentionally independent of wall clock.
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
  const catalogWithoutHash: Omit<BuiltTelemetryCatalog, "metadata"> & {
    metadata: Omit<CatalogMetadata, "contentHash">;
  } = {
    format: CATALOG_FORMAT,
    metadata: metadataWithoutHash,
    generatedFrom: [
      ...CATALOG_GENERATOR_SOURCE_FILES,
      ...TELEMETRY_TYPE_SOURCE_FILES,
      "shared/racing/setups/schema.ts",
      "shared/racing/setups/catalog/groups.ts",
      "shared/racing/setups/catalog/concepts.ts",
      "shared/racing/setups/catalog/parser-source-mappings.ts",
      "shared/racing/setups/catalog/file-source-mappings.ts",
      ...IRACING_SESSION_INFO_SOURCE_FILES,
      ...Object.values(PARSER_FILES),
      "data/diagnostics/iracing-all-vars-2026-07-29T02-06-39-162Z.json",
      ...iracingSessionInfoCaptureArtifacts,
    ],
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)),
    variables: [...variables.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sources: inventories,
    coverage: {
      normalizedPacketFields: packetFieldNames.length,
      semanticVariables: variables.size,
      sourceCounts,
    },
  };

  return {
    ...catalogWithoutHash,
    metadata: {
      ...metadataWithoutHash,
      contentHash: contentHash(catalogWithoutHash),
    },
  };
}