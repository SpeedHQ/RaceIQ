import type { GameId } from "./ids";
import type {
  TelemetryCatalogData,
  TelemetryVariableDefinition,
} from "../telemetry/catalog/contracts";
import type { TelemetryVariableId } from "../telemetry/catalog/generated/telemetry-catalog.types";

export type SemanticValueBinding = {
  kind: "value";
  semanticId: TelemetryVariableId;
};

export type SemanticDerivationBinding = {
  kind: "derived";
  derivation:
    | "g-force-v1"
    | "friction-circle-v1"
    | "physical-balance-v1"
    | "traction-v1"
    | "wear-rate-v1"
    | "compression-bias-v1";
  requires: readonly TelemetryVariableId[];
};

export type SemanticGroupBinding = {
  kind: "group";
  required: readonly TelemetryVariableId[];
  optional?: readonly TelemetryVariableId[];
};

export type SemanticMetricBinding =
  | SemanticValueBinding
  | SemanticDerivationBinding
  | SemanticGroupBinding;

type Presentation = {
  display?: "per-wheel" | "vehicle";
  freshness?: "continuous" | "pit-snapshot" | "static";
};

function lookup(
  gameId: GameId,
  metric: string,
  semanticId: TelemetryVariableId,
  catalog: TelemetryCatalogData,
): TelemetryVariableDefinition {
  const variable = catalog.variables.find(({ id }) => id === semanticId);
  if (!variable) {
    throw new Error(`${gameId}.${metric}: unknown semantic ${semanticId}`);
  }
  const mapping = variable.games[gameId];
  if (!mapping || mapping.kind === "unavailable") {
    throw new Error(`${gameId}.${metric}: ${semanticId} is unavailable`);
  }
  return variable;
}

function validatePresentation(
  gameId: GameId,
  metric: string,
  semanticId: TelemetryVariableId,
  variable: TelemetryVariableDefinition,
  presentation: Presentation,
): void {
  if (presentation.display === "per-wheel") {
    const cardinality = variable.cardinality;
    const orderedWheels = variable.ordering?.join(",");
    if (
      variable.shape !== "per-wheel" ||
      cardinality.kind !== "fixed" ||
      cardinality.count !== 4 ||
      orderedWheels !== "FL,FR,RL,RR"
    ) {
      throw new Error(
        `${gameId}.${metric}: ${semanticId} does not match per-wheel display`,
      );
    }
  } else if (presentation.display === "vehicle") {
    if (variable.shape !== "scalar" || variable.cardinality.kind !== "scalar") {
      throw new Error(
        `${gameId}.${metric}: ${semanticId} does not match vehicle display`,
      );
    }
  }

  if (presentation.freshness) {
    const mapping = variable.games[gameId];
    if (mapping.kind === "unavailable" || mapping.freshness !== presentation.freshness) {
      throw new Error(
        `${gameId}.${metric}: ${semanticId} freshness mismatch (expected ${presentation.freshness})`,
      );
    }
  }
}

export function assertSemanticBinding(
  gameId: GameId,
  metric: string,
  binding: SemanticMetricBinding,
  catalog: TelemetryCatalogData,
  presentation: Presentation = {},
): void {
  if (binding.kind === "value") {
    const variable = lookup(gameId, metric, binding.semanticId, catalog);
    validatePresentation(gameId, metric, binding.semanticId, variable, presentation);
    return;
  }

  if (binding.kind === "group") {
    for (const semanticId of binding.required) {
      const variable = lookup(gameId, metric, semanticId, catalog);
      validatePresentation(gameId, metric, semanticId, variable, presentation);
    }
    for (const semanticId of binding.optional ?? []) {
      const variable = lookup(gameId, metric, semanticId, catalog);
      validatePresentation(gameId, metric, semanticId, variable, presentation);
    }
    return;
  }

  for (const semanticId of binding.requires) {
    lookup(gameId, metric, semanticId, catalog);
  }
}
