// Canonical hashing and catalog contract inference.

import { createHash } from "node:crypto";
import { GAME_IDS } from "./model";
import { slug } from "./ast-discovery";
import type {
  CatalogVariable,
  SourceVariable,
  StructuredFieldSchema,
  StructuredIndexSchema,
  StructuredValueSchema,
  ValueType,
} from "./model";

// Catalog identifiers are ASCII; avoid runtime-specific Intl/ICU collation.
export function compareCatalogStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    let leftCode = left.charCodeAt(index);
    let rightCode = right.charCodeAt(index);
    if (leftCode >= 65 && leftCode <= 90) leftCode += 32;
    if (rightCode >= 65 && rightCode <= 90) rightCode += 32;
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareCatalogStrings(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function telemetryCatalogSourceHash(source: string): string {
  return contentHash(source.replace(/\r\n?/g, "\n"));
}

export const ENUM_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  "engine.fuel-mixture": ["lean", "standard", "rich", "max"],
  "fuel.ers-deploy-mode": ["0", "1", "2", "3", "4"],
  "race.competitor.pit-status": ["none", "pitting", "in-pit-area"],
  "race.driver-change-lap-status": ["0", "1", "2", "3"],
  "setup.tires.compound": ["0", "1"],
  "tires.tire-compound": [
    "7",
    "8",
    "16",
    "17",
    "18",
    "dry_compound",
    "wet_compound",
  ],
  "weather.skies": [
    "0",
    "1",
    "2",
    "3",
    "clear",
    "partly cloudy",
    "mostly cloudy",
    "overcast",
  ],
  "weather.weather-type": [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "constant",
    "dynamic",
  ],
};


export function dimensionForUnit(unit: string): readonly string[] {
  const normalized = unit.trim().toLowerCase();
  if (
    [
      "boolean",
      "bool",
      "text",
      "string",
      "structured",
      "id",
      "identifier",
      "code",
      "flags",
      "bitmask",
      "count",
      "index",
      "ratio",
      "fraction",
      "%",
      "percent",
      "0-1",
      "0-100",
      "0-255",
      "-128-127",
      "s/s",
      "game-native",
      "value-with-unit",
      "unknown",
    ].includes(normalized)
  ) {
    return ["dimensionless"];
  }
  if (/^(s|ms|min|h)$/.test(normalized)) return ["time"];
  if (/^(m|mm|cm|km|ft|in)$/.test(normalized)) return ["length"];
  if (/^(m\/s|km\/h|mph)$/.test(normalized)) return ["length", "time^-1"];
  if (/^(km\/l)$/.test(normalized)) return ["length^-2"];
  if (/^(l\/km)$/.test(normalized)) return ["length^2"];
  if (/^(m\/s(?:\^?2|²)|g)$/.test(normalized)) {
    return ["length", "time^-2"];
  }
  if (/^(rad|deg|°)$/.test(normalized)) return ["angle"];
  if (/^(rad\/s|deg\/s|rpm)$/.test(normalized)) {
    return ["angle", "time^-1"];
  }
  if (/^(°c|°f|c|f|k)$/.test(normalized)) return ["temperature"];
  if (/^(pa|kpa|bar|psi)$/.test(normalized)) {
    return ["mass", "length^-1", "time^-2"];
  }
  if (/^(l|ml|gal)$/.test(normalized)) return ["length^3"];
  if (/^(kg|g)$/.test(normalized)) return ["mass"];
  if (/^(kg\/h)$/.test(normalized)) return ["mass", "time^-1"];
  if (/^(n)$/.test(normalized)) return ["mass", "length", "time^-2"];
  if (/^(nm|n·m|n\*m)$/.test(normalized)) {
    return ["mass", "length^2", "time^-2"];
  }
  if (/^(j|kj|mj)$/.test(normalized)) {
    return ["mass", "length^2", "time^-2"];
  }
  if (/^(w|kw|hp|bhp)$/.test(normalized)) {
    return ["mass", "length^2", "time^-3"];
  }
  if (/^(a)$/.test(normalized)) return ["electric-current"];
  if (/^(v)$/.test(normalized)) {
    return ["mass", "length^2", "time^-3", "electric-current^-1"];
  }
  if (/^(kg\/m\^?3)$/.test(normalized)) return ["mass", "length^-3"];
  return [`unit:${normalized}`];
}

export function scalarValueTypeFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): Exclude<ValueType, "structured"> {
  const unit = variable.canonicalUnit.toLowerCase();
  const sourceTypes = sourceVariables
    .map((source) => source.dataType?.toLowerCase() ?? "")
    .filter(Boolean);
  if (unit === "boolean" || sourceTypes.some((type) => /\bbool/.test(type))) {
    return "boolean";
  }
  if (
    unit === "text" ||
    unit === "string" ||
    sourceTypes.some((type) => /\bstring\b/.test(type))
  ) {
    return "string";
  }
  if (unit === "enum" || sourceTypes.some((type) => /\benum\b/.test(type))) {
    return "enum";
  }
  return "number";
}

export function valueTypeFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): ValueType {
  return variable.shape === "structured"
    ? "structured"
    : scalarValueTypeFor(variable, sourceVariables);
}

export function structuredSchemaFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): StructuredValueSchema {
  const mappingSources = GAME_IDS.flatMap((gameId) => {
    const mapping = variable.games[gameId];
    if (mapping.kind === "unavailable") return [];
    return Array.isArray(mapping.sources)
      ? mapping.sources
      : Object.values(mapping.sources).flat();
  });
  const sourceMax = Math.max(
    0,
    ...sourceVariables.map((source) => source.count ?? 0),
  );
  let indices: StructuredIndexSchema[];
  if (variable.id.includes(".competitor.")) {
    indices = [
      {
        id: "competitor-index",
        cardinality: { kind: "variable", min: 0, max: Math.max(64, sourceMax) },
        ordering: "numeric-ascending",
      },
    ];
  } else if (variable.id.includes(".lap-history.")) {
    indices = [
      {
        id: "lap-number",
        cardinality: { kind: "variable", min: 0 },
        ordering: "numeric-ascending",
      },
    ];
  } else if (
    variable.id === "setup.tires.last-temperature-bands" ||
    variable.id === "setup.tires.tread-remaining"
  ) {
    indices = [
      {
        id: "wheel-position",
        cardinality: { kind: "fixed", count: 4 },
        ordering: "semantic-order",
      },
    ];
  } else if (variable.id === "setup.brakes.pad-compound") {
    indices = [
      {
        id: "axle-position",
        cardinality: { kind: "fixed", count: 2 },
        ordering: "semantic-order",
      },
    ];
  } else {
    const sourceIndices = [
      ...new Set(
        mappingSources.flatMap((source) =>
          [...source.matchAll(/([A-Za-z][A-Za-z0-9]*)\[\]/g)].map(
            (match) => `${slug(match[1].replace(/s$/i, ""))}-index`,
          ),
        ),
      ),
    ];
    indices =
      sourceIndices.length > 0
        ? sourceIndices.map((id) => ({
            id,
            cardinality: { kind: "variable" as const, min: 0 },
            ordering: "source-order" as const,
          }))
        : [
            {
              id: "source-path",
              cardinality:
                sourceMax > 1
                  ? { kind: "variable" as const, min: 0, max: sourceMax }
                  : { kind: "variable" as const, min: 0 },
              ordering: "source-order" as const,
            },
          ];
  }
  const scalarType = scalarValueTypeFor(variable, sourceVariables);
  const enumDomain = ENUM_DOMAINS[variable.id];
  const valueType =
    scalarType === "enum" && !enumDomain
      ? sourceVariables.some((source) =>
          /\bstring\b/i.test(source.dataType ?? ""),
        )
        ? ("string" as const)
        : ("number" as const)
      : scalarType;
  const fields: StructuredFieldSchema[] =
    variable.id === "setup.metadata.unmapped-source-values"
      ? [
          {
            id: "source-path",
            valueType: "string",
            dimensions: ["dimensionless"],
          },
          {
            id: "value",
            valueType: "string",
            dimensions: ["dimensionless"],
          },
        ]
      : [
          {
            id: "value",
            valueType,
            dimensions: dimensionForUnit(variable.canonicalUnit),
            ...(valueType === "enum" ? { enumDomain } : {}),
          },
        ];
  return { indices, fields };
}

export function cardinalityFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): Pick<CatalogVariable, "cardinality" | "ordering" | "structuredSchema"> {
  switch (variable.shape) {
    case "per-wheel":
      return {
        cardinality: { kind: "fixed", count: 4 },
        ordering: ["FL", "FR", "RL", "RR"],
      };
    case "vector":
      return {
        cardinality: { kind: "fixed", count: 3 },
        ordering: ["x", "y", "z"],
      };
    case "array":
      return {
        cardinality: { kind: "variable", min: 0 },
        ordering: ["source-order"],
      };
    case "structured": {
      const structuredSchema = structuredSchemaFor(variable, sourceVariables);
      const [primaryIndex] = structuredSchema.indices;
      const ordering =
        primaryIndex.id === "wheel-position"
          ? ["FL", "FR", "RL", "RR"]
          : primaryIndex.id === "axle-position"
            ? ["front", "rear"]
            : [`${primaryIndex.id}:${primaryIndex.ordering}`];
      return {
        cardinality: primaryIndex.cardinality,
        ordering,
        structuredSchema,
      };
    }
    default:
      return { cardinality: { kind: "scalar" } };
  }
}

export function rangeForUnit(
  unit: string,
): CatalogVariable["range"] | undefined {
  switch (unit.toLowerCase()) {
    case "fraction":
    case "ratio":
    case "0-1":
      return { min: 0, max: 1 };
    case "%":
    case "percent":
    case "0-100":
      return { min: 0, max: 100 };
    case "0-255":
      return { min: 0, max: 255 };
    case "-128-127":
      return { min: -128, max: 127 };
    default:
      return undefined;
  }
}
