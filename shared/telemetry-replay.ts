import type { MappingStatus } from "./telemetry-derivations";
import type {
  ConfidenceComponents,
  ResolutionProvenance,
  ResolutionState,
  SemanticSlot,
} from "./telemetry-resolver";
import type { GameId, TelemetryVersionIdentity } from "./types";

export type CanonicalTelemetryScalar =
  | number
  | boolean
  | string
  | null
  | readonly CanonicalTelemetryScalar[]
  | { readonly [key: string]: CanonicalTelemetryScalar };

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

export interface CanonicalTelemetryValue {
  readonly semanticId: string;
  readonly slot: SemanticSlot;
  readonly value: CanonicalTelemetryScalar;
  readonly unit: string | null;
  readonly mappingStatus: MappingStatus;
  readonly state: ResolutionState;
  readonly confidenceComponents: ConfidenceComponents;
  readonly confidence: number;
  readonly provenance: ResolutionProvenance;
  readonly schemaVersion: string;
  readonly limitations: readonly string[];
}

export interface TelemetryRawReference {
  /** Stable application identity; never exposes a local capture path. */
  readonly objectId: string;
  readonly contentHash: string;
  /** Encoding of the bytes addressed by byteOffset and hashed by contentHash. */
  readonly contentEncoding?: "identity" | "gzip";
  /** Encoding used by persisted storage before logical capture decoding. */
  readonly storageEncoding?: "identity" | "gzip";
  readonly byteOffset?: number;
  readonly frameCount?: number;
}

/** Resolver-backed frame emitted by historical or current telemetry replay. */
export interface CanonicalTelemetryEnvelope {
  readonly sessionId: string;
  readonly sequence: bigint;
  readonly observedAt: number;
  /** Lap-row persistence time when the source did not retain receive timestamps. */
  readonly receivedAt: number;
  readonly simulator: GameId;
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly catalogSchemaVersion: string;
  readonly parserVersion: string;
  readonly resolverVersion: string;
  readonly derivationVersion: string;
  /** Runtime identity originally stored with the capture, absent on legacy rows. */
  readonly recordedWith?: TelemetryVersionIdentity;
  readonly values: readonly CanonicalTelemetryValue[];
  readonly rawReference?: TelemetryRawReference;
}

export interface SemanticTelemetryReplay {
  readonly lapId: number;
  readonly requestedSemanticIds: readonly string[];
  readonly envelopes: readonly CanonicalTelemetryEnvelope[];
}
