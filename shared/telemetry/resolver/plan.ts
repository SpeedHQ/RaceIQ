import type { GameId } from "../../games/ids";
import type { TelemetryVariableDefinition } from "../catalog/contracts";
import type { TelemetryDerivation } from "../derivations/contracts";
import type { SemanticSlot } from "./contracts";

export type RuntimeCatalogMetadata = {
  catalogVersion?: string;
  schemaVersion?: string;
  contentHash?: string;
};
export type NativeObject = Record<string, unknown>;
export type Mapping = TelemetryVariableDefinition["games"][GameId];
export type Reader = (frame: NativeObject) => unknown;

export interface ResolutionPlan {
  semanticId: string;
  variable: TelemetryVariableDefinition;
  mapping: Mapping;
  reader?: Reader;
  derivation?: TelemetryDerivation;
  executorError?: string;
  staleAfterMs: number;
}

export interface RuntimeResolver {
  readonly plans: readonly ResolutionPlan[];
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly schemaVersion: string;
  readonly simulator: GameId;
  readonly parserId: string;
  readonly parserVersion: string;
  slot(semanticId: string): SemanticSlot;
}
