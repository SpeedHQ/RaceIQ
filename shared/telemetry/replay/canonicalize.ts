import type { CanonicalTelemetryScalar } from "./contracts";

function cloneCanonicalTelemetryScalar(
  value: unknown,
  semanticId: string,
  ancestors: Set<object>,
): CanonicalTelemetryScalar {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(
      `Telemetry replay value for ${semanticId} contains a non-finite number`,
    );
  }
  if (typeof value !== "object") {
    throw new TypeError(
      `Telemetry replay value for ${semanticId} contains unsupported ${typeof value}`,
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError(
      `Telemetry replay value for ${semanticId} contains a cycle`,
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: CanonicalTelemetryScalar[] = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(
            `Telemetry replay value for ${semanticId} contains a sparse array`,
          );
        }
        clone[index] = cloneCanonicalTelemetryScalar(
          value[index],
          semanticId,
          ancestors,
        );
      }
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `Telemetry replay value for ${semanticId} must contain only plain objects`,
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(
        `Telemetry replay value for ${semanticId} contains symbol keys`,
      );
    }
    const clone: Record<string, CanonicalTelemetryScalar> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new TypeError(
          `Telemetry replay value for ${semanticId} contains an accessor`,
        );
      }
      Object.defineProperty(clone, key, {
        value: cloneCanonicalTelemetryScalar(
          descriptor.value,
          semanticId,
          ancestors,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

/** Validate and detach one JSON-compatible value for canonical replay output. */
export function canonicalizeTelemetryScalar(
  value: unknown,
  semanticId: string,
): CanonicalTelemetryScalar {
  return cloneCanonicalTelemetryScalar(value, semanticId, new Set());
}

