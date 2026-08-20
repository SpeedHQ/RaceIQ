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

const TIMING_SECONDS_UNITS: Readonly<Record<string, true>> = {
  "timing.delta-to-reference": true,
  "timing.gap-ahead": true,
  "timing.gap-behind": true,
  "timing.pit-lane-time-in-lane": true,
  "timing.session-time-remaining": true,
  "timing.session-time-total": true,
  "timing.time-of-day": true,
  "timing.total-driving-time": true,
  "session.timestamp": true,
};

const FUEL_MIXTURE_BY_LEVEL: Readonly<Record<number, string>> = {
  0: "lean",
  1: "standard",
  2: "rich",
  3: "max",
};

const WHEEL_SOURCE_KEY_ALIASES: Readonly<Record<string, string>> = {
  FL: "LF",
  FR: "RF",
  RL: "LR",
  RR: "RR",
};

function declaresPacketSource(sourcePaths: readonly string[], sourceField: string): boolean {
  return sourcePaths.includes(
    sourceField.startsWith("TelemetryPacket.") ? sourceField : `TelemetryPacket.${sourceField}`,
  );
}

function normalizeBooleanValue(input: unknown): boolean | undefined {
  if (typeof input === "boolean") return input;
  if (typeof input === "number" && Number.isFinite(input)) return input !== 0;
  if (typeof input !== "string") return undefined;
  const value = input.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

function normalizeFuelMixture(input: unknown): string | undefined {
  if (typeof input === "string") {
    const value = input.trim().toLowerCase();
    if (value === "lean") return "lean";
    if (value === "standard" || value === "std") return "standard";
    if (value === "rich") return "rich";
    if (value === "max") return "max";
    return undefined;
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return FUEL_MIXTURE_BY_LEVEL[input] ?? undefined;
  }
  return undefined;
}


function sourcesForOrderingKey(keyedSources: Record<string, readonly string[]>, key: string): readonly string[] | undefined {
  return keyedSources[key] ?? keyedSources[WHEEL_SOURCE_KEY_ALIASES[key]];
}

function canonicalPacketValue(semanticId: string, value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  if (
    semanticId === "inputs.throttle" ||
    semanticId === "inputs.brake" ||
    semanticId === "inputs.clutch" ||
    semanticId === "inputs.handbrake"
  ) {
    return Math.max(0, Math.min(1, value / 255));
  }
  if (semanticId === "inputs.steering") {
    const ratio = value >= 0 ? value / 127 : value / 128;
    return Math.max(-1, Math.min(1, ratio));
  }
  return value;
}

export function trustedNativeExecutor(variable: TelemetryVariableDefinition, mapping: Exclude<Mapping, { kind: "unavailable" }>): Reader | undefined {
  if (mapping.kind !== "normalized" || mapping.execution?.kind !== "conversion") return undefined;

  const sourcePaths = sources(mapping);
  const nativeUnit = mapping.nativeUnit.trim().toLowerCase();
  const reading = {} as SourceReading;
  if (variable.id === "fuel.remaining-fraction" && sourcePaths.includes("iRacing.FuelLevelPct")) {
    return (frame, context) => {
      const directSource = "iRacing.FuelLevelPct";
      const directValue = sourceValue(frame, directSource);
      if (typeof directValue === "number" && Number.isFinite(directValue)) {
        return setReading(reading, context, mapping, directSource, directValue);
      }
      const volumeSource = "TelemetryPacket.Fuel";
      const capacitySource = "TelemetryPacket.FuelCapacity";
      const volume = sourcePaths.includes(volumeSource) ? sourceValue(frame, volumeSource) : undefined;
      const capacity = sourcePaths.includes(capacitySource) ? sourceValue(frame, capacitySource) : undefined;
      if (typeof volume === "number" && Number.isFinite(volume) && typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0) {
        return setReading(reading, context, mapping, volumeSource, volume, volume / capacity);
      }
      return undefined;
    };
  }
  if (variable.id === "tire.temperature.average" && nativeUnit === "°f") {
    const fields = variable.packetFields?.filter((field) =>
      declaresPacketSource(sourcePaths, String(field))
    );
    if (!fields || fields.length !== 4) return undefined;
    const sourceChannels = fields.map((field) => `TelemetryPacket.${String(field)}`);
    const observationKey = sourceChannels.join("|");
    const rawValues = new Array<number>(fields.length);
    const values = new Array<number>(fields.length);
    return (frame, context) => {
      for (let index = 0; index < fields.length; index += 1) {
        const value = packetField(frame, fields[index]);
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
        rawValues[index] = value;
        values[index] = (value - 32) * 5 / 9;
      }
      reading.value = values;
      reading.observation = context.observe(observationKey, rawValues, mapping.freshness);
      reading.sourceChannel = sourceChannels[0];
      return reading;
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
  if (TIMING_SECONDS_UNITS[variable.id] && nativeUnit === "ms") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return setReading(reading, context, mapping, source, value, value / 1_000);
        }
      }
      return undefined;
    };
  }
  if (variable.id === "timing.time-of-day") {
    return (frame, context) => {
      let hours: number | undefined;
      let minutes: number | undefined;
      let seconds: number | undefined;
      let observationSource = "";
      let observationValue: unknown;
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        if (source.endsWith("timeOfDayHours")) hours = value;
        if (source.endsWith("timeOfDayMinutes")) minutes = value;
        if (source.endsWith("timeOfDaySeconds")) seconds = value;
        if (observationSource === "") {
          observationSource = source;
          observationValue = value;
        }
      }
      if (hours === undefined || minutes === undefined || seconds === undefined) return undefined;
      return setReading(reading, context, mapping, observationSource, observationValue, hours * 3_600 + minutes * 60 + seconds);
    };
  }
  if (variable.id === "brakes.abs-active") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        const normalized = normalizeBooleanValue(value);
        if (normalized !== undefined) return setReading(reading, context, mapping, source, value, normalized);
      }
      return undefined;
    };
  }
  if (variable.id === "engine.fuel-mixture") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        const normalized = normalizeFuelMixture(value);
        if (normalized !== undefined) return setReading(reading, context, mapping, source, value, normalized);
      }
      return undefined;
    };
  }
  if (variable.id === "engine.power" && nativeUnit === "bhp") {
    return (frame, context) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value) && (source.includes("bhp") || source.includes("Bhp"))) {
          return setReading(reading, context, mapping, source, value, value * 745.7);
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
  const sourcePaths = sources(mapping);
  const keyedSources: Record<string, readonly string[]> | undefined = Array.isArray(mapping.sources) ? undefined : (mapping.sources as Record<string, readonly string[]>);
  const keyedCollection = keyedSources !== undefined && variable.shape !== "structured";
  const ordering = keyedCollection ? (variable.ordering ?? Object.keys(keyedSources)) : undefined;
  const normalizedLateralSlip = variable.id === "tires.normalized-tire-slip-angle";
  if ((fields && fields.length > 1) || keyedCollection) {
    const count = normalizedLateralSlip ? 4 : Math.max(fields?.length ?? 0, ordering?.length ?? 0);
    const values = new Array<unknown>(count);
    const reading = {} as SourceReading;
    const observationKey = fields
      ? fields.filter((field) => declaresPacketSource(sourcePaths, String(field))).map((field) => `TelemetryPacket.${String(field)}`).join("|")
      : Object.values(keyedSources ?? {}).flat().join("|");
    return (frame, context) => {
      let available = 0;
      let firstSource = "";
      for (let index = 0; index < count; index += 1) {
        let value: unknown;
        let sourceChannel: string | undefined;
        if (normalizedLateralSlip && fields) {
          const packetSource = fields[index + 1];
          if (packetSource && declaresPacketSource(sourcePaths, String(packetSource))) {
            value = packetField(frame, packetSource);
            if (value !== undefined) sourceChannel = `TelemetryPacket.${String(packetSource)}`;
          }
        } else {
          if (fields && index < fields.length && declaresPacketSource(sourcePaths, String(fields[index]))) {
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
      reading.observation = context.observe(observationKey || firstSource, values, mapping.freshness);
      reading.sourceChannel = firstSource;
      return reading;
    };
  }
  const field = fields?.[0];
  const declaredPacketField = field !== undefined && declaresPacketSource(sourcePaths, String(field));
  const reading = {} as SourceReading;
  return (frame, context) => {
    if (field && declaredPacketField) {
      const value = packetField(frame, field);
      if (value !== undefined) {
        return setReading(reading, context, mapping, `TelemetryPacket.${String(field)}`, value, canonicalPacketValue(variable.id, value));
      }
      if (mapping.kind === "normalized") return undefined;
    }
    for (const source of sourcePaths) {
      if (source.startsWith("TelemetryPacket.")) {
        if (field && source === `TelemetryPacket.${String(field)}`) continue;
      }
      const value = sourceValue(frame, source);
      if (value !== undefined) return setReading(reading, context, mapping, source, value);
    }
    return undefined;
  };
}
