import type { RaceResultProvenance } from "../../shared/racing/results/types";
import type { GameId } from "../../shared/games/ids";
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
const RACE_RESULT_DERIVATION_VERSION = "3";
const RACE_RESULT_DERIVATION_CODE_HASH = "sha256:cffa4cebb957096212111001a2dcc14186df97a4bf74734fc853db6054c4c8e8";

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
