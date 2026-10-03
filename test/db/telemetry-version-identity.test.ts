import { expect, test } from "bun:test";
import {
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "@raceiq/shared/telemetry/catalog/data";
import { TELEMETRY_DERIVATION_VERSION } from "@raceiq/shared/telemetry/derivations/builtins";
import {
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
} from "@raceiq/shared/telemetry/resolver/versions";
import { deleteSession, getSessions, } from "@raceiq/backend-core/db/session-queries";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { initServerGameAdapters } from "@raceiq/backend/games/init";
import { RealDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports"
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
initServerGameAdapters();






test("production adapter stamps current runtime identity on sessions and laps", async () => {
  const adapter = new RealDbAdapter();
  const expected: TelemetryVersionIdentity = {
    catalogVersion: TELEMETRY_CATALOG_VERSION,
    catalogHash: TELEMETRY_CATALOG_HASH,
    catalogSchemaVersion: TELEMETRY_CATALOG_SCHEMA_VERSION,
    parserVersion: TELEMETRY_PARSER_VERSIONS.iracing,
    resolverVersion: TELEMETRY_RESOLVER_VERSION,
    derivationVersion: TELEMETRY_DERIVATION_VERSION,
  };
  const sessionId = await adapter.insertSession(990_205, 991_205, "iracing");
  try {
    const lapId = await adapter.insertLap(
      sessionId,
      1,
      88.5,
      true,
      null,
      0,
      null,
      null,
      null,
      null,
    );

    expect(await getLapById(lapId)).toMatchObject(expected);
    const session = (await getSessions("iracing")).find((row) => row.id === sessionId);
    expect(session).toMatchObject(expected);
  } finally {
    await deleteSession(sessionId);
  }
});
