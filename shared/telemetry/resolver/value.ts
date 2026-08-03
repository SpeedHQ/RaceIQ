import type { TelemetryVariableDefinition } from "../catalog/contracts";
import type { TelemetryPacket } from "../types";
import type { Mapping, NativeObject } from "./plan";

export function sources(mapping: Exclude<Mapping, { kind: "unavailable" }>): readonly string[] { return Array.isArray(mapping.sources) ? mapping.sources : Object.values(mapping.sources).flat(); }
export function readPath(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as NativeObject)[key];
  }
  return value;
}
export const INVALID_VALUE = Symbol("invalid telemetry value");
export function packetField(frame: NativeObject, field: keyof TelemetryPacket): unknown {
  return frame[field] ??
    (frame.packet !== null && typeof frame.packet === "object"
      ? (frame.packet as NativeObject)[field]
      : undefined);
}
function cardinalityAccepts(
  count: number,
  cardinality: TelemetryVariableDefinition["cardinality"],
): boolean {
  return cardinality.kind === "scalar"
    ? count === 1
    : cardinality.kind === "fixed"
      ? count === cardinality.count
      : count >= cardinality.min &&
        (cardinality.max === undefined || count <= cardinality.max);
}

function primitiveAccepts(
  value: unknown,
  valueType: Exclude<
    TelemetryVariableDefinition["valueType"],
    "structured"
  >,
  enumDomain?: readonly string[],
): boolean {
  if (valueType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "string") return typeof value === "string";
  return (
    typeof value === "string" &&
    (enumDomain === undefined || enumDomain.includes(value))
  );
}

function indexedLength(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    "length" in value &&
    typeof value.length === "number"
  ) {
    return value.length;
  }
  return undefined;
}

function indexedValue(value: unknown, index: number): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, String(index))
    : undefined;
}

function structuredValueAccepts(
  variable: TelemetryVariableDefinition,
  input: unknown,
): boolean {
  const schema = variable.structuredSchema;
  if (!schema) return input !== null && typeof input === "object";

  const validate = (value: unknown, depth: number): boolean => {
    if (depth < schema.indices.length) {
      const length = indexedLength(value);
      if (
        length === undefined ||
        !cardinalityAccepts(length, schema.indices[depth].cardinality)
      ) {
        return false;
      }
      for (let index = 0; index < length; index += 1) {
        if (!validate(indexedValue(value, index), depth + 1)) return false;
      }
      return true;
    }

    if (schema.fields.length === 1 && schema.fields[0].id === "value") {
      const field = schema.fields[0];
      let leaf = value;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "value" in value
      ) {
        leaf = value.value;
      }
      return primitiveAccepts(leaf, field.valueType, field.enumDomain);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return schema.fields.every((field) =>
      primitiveAccepts(
        readPath(value, [field.id]),
        field.valueType,
        field.enumDomain,
      ),
    );
  };

  return validate(input, 0);
}

function canonicalEnum(
  input: unknown,
  domain?: readonly string[],
): string | typeof INVALID_VALUE {
  const value =
    typeof input === "string"
      ? input
      : typeof input === "number" && Number.isFinite(input)
        ? String(input)
        : undefined;
  return value !== undefined && (domain === undefined || domain.includes(value))
    ? value
    : INVALID_VALUE;
}

export function canonicalValue(
  variable: TelemetryVariableDefinition,
  input: unknown,
): unknown | typeof INVALID_VALUE {
  const expectsCollection =
    variable.shape === "per-wheel" ||
    variable.shape === "vector" ||
    variable.shape === "array";
  if (expectsCollection && !Array.isArray(input)) return INVALID_VALUE;
  if (
    !expectsCollection &&
    variable.shape !== "structured" &&
    Array.isArray(input)
  ) {
    return INVALID_VALUE;
  }
  if (variable.shape === "structured") {
    return structuredValueAccepts(variable, input) ? input : INVALID_VALUE;
  }
  if (Array.isArray(input)) {
    if (
      !cardinalityAccepts(input.length, variable.cardinality) ||
      (variable.ordering !== undefined &&
        input.length !== variable.ordering.length)
    ) {
      return INVALID_VALUE;
    }
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index];
      if (variable.valueType === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return INVALID_VALUE;
        }
      } else if (variable.valueType === "boolean") {
        if (
          typeof value !== "boolean" &&
          (typeof value !== "number" || !Number.isFinite(value))
        ) {
          return INVALID_VALUE;
        }
        input[index] = typeof value === "boolean" ? value : value !== 0;
      } else if (variable.valueType === "string") {
        if (typeof value !== "string") return INVALID_VALUE;
      } else if (variable.valueType === "enum") {
        const canonical = canonicalEnum(value, variable.enumDomain);
        if (canonical === INVALID_VALUE) return INVALID_VALUE;
        input[index] = canonical;
      }
    }
    return input;
  }
  if (variable.valueType === "number") {
    return typeof input === "number" && Number.isFinite(input)
      ? input
      : INVALID_VALUE;
  }
  if (variable.valueType === "boolean") {
    if (typeof input === "boolean") return input;
    return typeof input === "number" && Number.isFinite(input)
      ? input !== 0
      : INVALID_VALUE;
  }
  if (variable.valueType === "string") {
    return typeof input === "string" ? input : INVALID_VALUE;
  }
  if (variable.valueType === "enum") {
    return canonicalEnum(input, variable.enumDomain);
  }
  return INVALID_VALUE;
}
