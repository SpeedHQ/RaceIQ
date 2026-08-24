import type { TelemetryVariableDefinition } from "../catalog/contracts";
import type { Mapping, NativeObject, Reader, ReaderContext, SourceReading } from "./plan";
import { packetField, readCollectionPath, sources } from "./value";

function sourceValue(frame: NativeObject, source: string): unknown {
  const packet = frame.packet ?? frame;
  if (source.startsWith("TelemetryPacket.")) {
    return readCollectionPath(packet, source.slice(16).split("."));
  }
  const packetValue = readCollectionPath(packet, source.split("."));
  if (packetValue !== undefined) return packetValue;
  const nativeValues = frame.nativeValues !== null && typeof frame.nativeValues === "object" ? (frame.nativeValues as NativeObject) : undefined;
  if (!nativeValues) return undefined;
  const nativePath = source.split(".").slice(1);
  const flatKey = nativePath.join(".");
  return flatKey in nativeValues ? nativeValues[flatKey] : readCollectionPath(nativeValues, nativePath);
}

function setReading(
  reading: SourceReading,
  context: ReaderContext,
  mapping: Exclude<Mapping, { kind: "unavailable" }>,
  sourceChannel: string,
  sourceValue: unknown,
  value: unknown = sourceValue,
): SourceReading {
  reading.value = value;
  reading.observation = context.observe(sourceChannel, sourceValue, mapping.freshness);
  reading.sourceChannel = sourceChannel;
  return reading;
}

const WHEEL_SOURCE_KEY_ALIASES: Readonly<Record<string, string>> = {
  FL: "LF",
  FR: "RF",
  RL: "LR",
  RR: "RR",
};
const PIT_STATUS_CODES: Readonly<Record<string, number>> = {
  out: 0,
  pit_lane: 1,
  in_pit: 2,
};

function sourcesForOrderingKey(keyedSources: Record<string, readonly string[]>, key: string): readonly string[] | undefined {
  return keyedSources[key] ?? keyedSources[WHEEL_SOURCE_KEY_ALIASES[key]];
}

export function trustedNativeExecutor(variable: TelemetryVariableDefinition, mapping: Exclude<Mapping, { kind: "unavailable" }>): Reader | undefined {
  if (mapping.kind !== "normalized" || mapping.execution?.kind !== "conversion") {
    return undefined;
  }

  const sourcePaths = sources(mapping);
  const nativeUnit = mapping.nativeUnit.trim().toLowerCase();
  const reading = {} as SourceReading;
  if (variable.id === "fuel.fuel-percent" && nativeUnit === "fraction") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return setReading(reading, context, mapping, source, value, value * 100);
        }
      }
      return undefined;
    };
  }
  if (variable.id === "timing.lap-fraction" && nativeUnit === "fraction") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return setReading(reading, context, mapping, source, value, Math.max(0, Math.min(1, value)));
        }
      }
      return undefined;
    };
  }
  if (variable.id === "race.pit-status" && nativeUnit === "text") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value !== "string") continue;
        const normalized = PIT_STATUS_CODES[value.trim().toLowerCase()];
        if (normalized !== undefined) {
          return setReading(reading, context, mapping, source, value, normalized);
        }
      }
      return undefined;
    };
  }
  if (variable.id !== "timing.track-length") return undefined;

  const multiplier = nativeUnit === "km" ? 1_000 : nativeUnit === "m" ? 1 : undefined;
  if (multiplier === undefined) return undefined;

  return (frame, context) => {
    for (const source of sourcePaths) {
      const value = sourceValue(frame, source);
      if (typeof value === "number" && Number.isFinite(value)) {
        return setReading(reading, context, mapping, source, value, value * multiplier);
      }
      if (typeof value !== "string") continue;
      const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(km|m)$/i);
      if (!match) continue;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      return setReading(reading, context, mapping, source, value, amount * (match[2].toLowerCase() === "km" ? 1_000 : 1));
    }
    return undefined;
  };
}

export function readerFor(variable: TelemetryVariableDefinition, mapping: Exclude<Mapping, { kind: "unavailable" }>): Reader | undefined {
  const fields = variable.packetFields;
  const keyedSources: Record<string, readonly string[]> | undefined = Array.isArray(mapping.sources) ? undefined : (mapping.sources as Record<string, readonly string[]>);
  const keyedCollection = keyedSources !== undefined && variable.shape !== "structured";
  const ordering = keyedCollection ? (variable.ordering ?? Object.keys(keyedSources)) : undefined;
  const normalizedLateralSlip = variable.id === "tires.normalized-tire-slip-angle";
  if ((fields && fields.length > 1) || keyedCollection) {
    const count = normalizedLateralSlip ? 4 : Math.max(fields?.length ?? 0, ordering?.length ?? 0);
    const values = new Array<unknown>(count);
    const reading = {} as SourceReading;
    const observationKey = fields
      ? fields.map((field) => `TelemetryPacket.${String(field)}`).join("|")
      : Object.values(keyedSources ?? {})
          .flat()
          .join("|");
    return (frame, context) => {
      let available = 0;
      let firstSource = "";
      for (let index = 0; index < count; index += 1) {
        let value: unknown;
        let sourceChannel: string | undefined;
        if (normalizedLateralSlip && fields) {
          value = packetField(frame, fields[index + 1]);
          if (value !== undefined) sourceChannel = `TelemetryPacket.${String(fields[index + 1])}`;
        } else {
          if (fields && index < fields.length) {
            value = packetField(frame, fields[index]);
            if (value !== undefined) sourceChannel = `TelemetryPacket.${String(fields[index])}`;
          }
          if (value === undefined && mapping.kind !== "normalized" && keyedSources && ordering) {
            for (const source of sourcesForOrderingKey(keyedSources, ordering[index]) ?? []) {
              value = sourceValue(frame, source);
              if (value !== undefined) {
                sourceChannel = source;
                break;
              }
            }
          }
        }
        values[index] = value;
        if (value === undefined || sourceChannel === undefined) continue;
        available += 1;
        if (firstSource === "") firstSource = sourceChannel;
      }
      if (available === 0) return undefined;
      reading.value = values;
      reading.observation = context.observe(observationKey, values, mapping.freshness);
      reading.sourceChannel = firstSource;
      return reading;
    };
  }
  const field = fields?.[0];
  const sourcePaths = sources(mapping);
  const reading = {} as SourceReading;
  return (frame, context) => {
    if (field) {
      const value = packetField(frame, field);
      if (value !== undefined) {
        return setReading(reading, context, mapping, `TelemetryPacket.${String(field)}`, value);
      }
      if (mapping.kind === "normalized") return undefined;
    }
    for (const source of sourcePaths) {
      const value = sourceValue(frame, source);
      if (value !== undefined) {
        return setReading(reading, context, mapping, source, value);
      }
    }
    return undefined;
  };
}
