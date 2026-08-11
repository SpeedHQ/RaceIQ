import type { GameId } from "../../games/ids";
import type { MappingStatus } from "../derivations/contracts";
import type { ConfidenceComponents, FreshnessState, ResolutionProvenance, ResolutionState, SemanticSlot, TelemetryTimestamp } from "../resolver/contracts";
import type { TelemetryVersionIdentity } from "../version";

export type CanonicalTelemetryScalar = number | boolean | string | null | readonly CanonicalTelemetryScalar[] | { readonly [key: string]: CanonicalTelemetryScalar };

export interface CanonicalTelemetryValue {
  readonly semanticId: string;
  readonly slot: SemanticSlot;
  readonly value: CanonicalTelemetryScalar;
  readonly unit: string | null;
  readonly mappingStatus: MappingStatus;
  readonly state: ResolutionState;
  readonly freshness: FreshnessState;
  readonly confidenceComponents: ConfidenceComponents;
  readonly confidence: number | null;
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
  readonly observedAt: TelemetryTimestamp;
  /** Lap-row persistence time in Unix wall-clock domain. */
  readonly receivedAt: TelemetryTimestamp;
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
