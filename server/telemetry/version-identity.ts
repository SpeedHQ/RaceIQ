import type { GameId } from "../../shared/games/ids";
import { TELEMETRY_CATALOG_HASH, TELEMETRY_CATALOG_SCHEMA_VERSION, TELEMETRY_CATALOG_VERSION } from "../../shared/telemetry/catalog/data";
import { telemetryDerivationVersionIdentity } from "../../shared/telemetry/derivations/builtins";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../shared/telemetry/resolver/versions";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { GAME_RACE_EVENT_DERIVATIONS } from "../games/race-event-derivations";

/** Version identity shared by capture, replay, and analysis provenance. */
export function currentTelemetryVersionIdentity(gameId: GameId): TelemetryVersionIdentity {
  return {
    catalogVersion: TELEMETRY_CATALOG_VERSION,
    catalogHash: TELEMETRY_CATALOG_HASH,
    catalogSchemaVersion: TELEMETRY_CATALOG_SCHEMA_VERSION,
    parserVersion: TELEMETRY_PARSER_VERSIONS[gameId],
    resolverVersion: TELEMETRY_RESOLVER_VERSION,
    derivationVersion: telemetryDerivationVersionIdentity(GAME_RACE_EVENT_DERIVATIONS[gameId].derivations),
  };
}
