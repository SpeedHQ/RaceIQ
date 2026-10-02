import type { RaceResultProvenance } from "../../shared/racing/results/types";
import type { GameId } from "@raceiq/games/ids";
import {
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "../../shared/telemetry/catalog/data";
import {
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
} from "../../shared/telemetry/resolver/versions";
import { RACE_RESULT_OUTCOME_POLICY } from "./authority";

const RACE_RESULT_DERIVATION_ID = "race-result-derivation";
const RACE_RESULT_DERIVATION_VERSION = "5";
const RACE_RESULT_DERIVATION_CODE_HASH = "sha256:679c2a2e740f21cacf5fd4dd831f8a78a6a511705897861def7761c5a8652bc5";

export function createRaceResultProvenance(
  gameId: GameId,
  overrides: Partial<RaceResultProvenance> = {},
): RaceResultProvenance {
  return {
    catalogVersion: TELEMETRY_CATALOG_VERSION,
    catalogHash: TELEMETRY_CATALOG_HASH,
    catalogSchemaVersion: TELEMETRY_CATALOG_SCHEMA_VERSION,
    parserVersion: TELEMETRY_PARSER_VERSIONS[gameId],
    resolverVersion: TELEMETRY_RESOLVER_VERSION,
    derivationId: RACE_RESULT_DERIVATION_ID,
    derivationVersion: RACE_RESULT_DERIVATION_VERSION,
    derivationCodeHash: RACE_RESULT_DERIVATION_CODE_HASH,
    rawInput: null,
    canonicalInput: null,
    authorityPolicyId: RACE_RESULT_OUTCOME_POLICY.id,
    authorityPolicyVersion: RACE_RESULT_OUTCOME_POLICY.version,
    ...overrides,
  };
}
