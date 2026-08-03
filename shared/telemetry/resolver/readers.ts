import type { TelemetryVariableDefinition } from "../catalog/contracts";
import type { Mapping, NativeObject, Reader } from "./plan";
import { packetField, readPath, sources } from "./value";

function sourceValue(frame: NativeObject, source: string): unknown {
  const packet = frame.packet ?? frame;
  if (source.startsWith("TelemetryPacket.")) {
    return readPath(packet, source.slice(16).split("."));
  }
  const packetValue = readPath(packet, source.split("."));
  if (packetValue !== undefined) return packetValue;
  const nativeValues =
    frame.nativeValues !== null && typeof frame.nativeValues === "object"
      ? frame.nativeValues as NativeObject
      : undefined;
  if (!nativeValues) return undefined;
  const nativePath = source.split(".").slice(1);
  const flatKey = nativePath.join(".");
  return flatKey in nativeValues
    ? nativeValues[flatKey]
    : readPath(nativeValues, nativePath);
}

const WHEEL_SOURCE_KEY_ALIASES: Readonly<Record<string, string>> = {
  FL: "LF",
  FR: "RF",
  RL: "LR",
  RR: "RR",
};

function sourcesForOrderingKey(
  keyedSources: Record<string, readonly string[]>,
  key: string,
): readonly string[] | undefined {
  return (
    keyedSources[key] ??
    keyedSources[WHEEL_SOURCE_KEY_ALIASES[key]]
  );
}

export function trustedNativeExecutor(
  variable: TelemetryVariableDefinition,
  mapping: Exclude<Mapping, { kind: "unavailable" }>,
): Reader | undefined {
  if (
    mapping.kind !== "normalized" ||
    mapping.execution?.kind !== "conversion"
  ) {
    return undefined;
  }

  const sourcePaths = sources(mapping);
  const nativeUnit = mapping.nativeUnit.trim().toLowerCase();
  if (variable.id === "fuel.fuel-percent" && nativeUnit === "fraction") {
    return (frame) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return value * 100;
        }
      }
      return undefined;
    };
  }
  if (variable.id === "timing.lap-fraction" && nativeUnit === "fraction") {
    return (frame) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return Math.max(0, Math.min(1, value));
        }
      }
      return undefined;
    };
  }
  if (variable.id !== "timing.track-length") return undefined;

  const multiplier = nativeUnit === "km" ? 1_000 : nativeUnit === "m" ? 1 : undefined;
  if (multiplier === undefined) return undefined;

  return (frame) => {
    for (const source of sourcePaths) {
      const value = sourceValue(frame, source);
      if (typeof value === "number" && Number.isFinite(value)) {
        return value * multiplier;
      }
      if (typeof value !== "string") continue;
      const match = value.trim().match(
        /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(km|m)$/i,
      );
      if (!match) continue;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      return amount * (match[2].toLowerCase() === "km" ? 1_000 : 1);
    }
    return undefined;
  };
}

export function readerFor(
  variable: TelemetryVariableDefinition,
  mapping: Exclude<Mapping, { kind: "unavailable" }>,
): Reader | undefined {
  const fields = variable.packetFields;
  const keyedSources: Record<string, readonly string[]> | undefined =
    Array.isArray(mapping.sources)
      ? undefined
      : mapping.sources as Record<string, readonly string[]>;
  const keyedCollection =
    keyedSources !== undefined && variable.shape !== "structured";
  const ordering = keyedCollection
    ? variable.ordering ?? Object.keys(keyedSources)
    : undefined;
  if ((fields && fields.length > 1) || keyedCollection) {
    const count = Math.max(fields?.length ?? 0, ordering?.length ?? 0);
    const values = new Array<unknown>(count);
    return (frame) => {
      let available = 0;
      for (let index = 0; index < count; index += 1) {
        let value =
          fields && index < fields.length
            ? packetField(frame, fields[index])
            : undefined;
        if (
          value === undefined &&
          mapping.kind !== "normalized" &&
          keyedSources &&
          ordering
        ) {
          for (const source of
            sourcesForOrderingKey(keyedSources, ordering[index]) ?? []) {
            value = sourceValue(frame, source);
            if (value !== undefined) break;
          }
        }
        values[index] = value;
        if (value !== undefined) available += 1;
      }
      return available === 0 ? undefined : values;
    };
  }
  const field = fields?.[0];
  const sourcePaths = sources(mapping);
  return (frame) => {
    if (field) {
      const value = packetField(frame, field);
      if (value !== undefined) return value;
      if (mapping.kind === "normalized") return undefined;
    }
    for (const source of sourcePaths) {
      const value = sourceValue(frame, source);
      if (value !== undefined) return value;
    }
    return undefined;
  };
}
