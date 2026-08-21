import { expect, test } from "bun:test";
import { TELEMETRY_CATALOG_HASH, TELEMETRY_CATALOG_SCHEMA_VERSION, TELEMETRY_CATALOG_VERSION } from "../../shared/telemetry/catalog/data";
import { TELEMETRY_DERIVATION_VERSION } from "../../shared/telemetry/derivations/builtins";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../shared/telemetry/resolver/versions";
import { deleteSession, getSessions } from "../../server/db/session-queries";
import { getLapById, getLaps } from "../../server/db/lap-read-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { RealDbAdapter } from "../../server/telemetry/pipeline-ports";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
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
    const lapId = await adapter.insertLap({
      sessionId,
      lapNumber: 1,
      lapTime: 88.5,
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: 0,
      profileId: null,
      tuneId: null,
      invalidReason: null,
      sectors: null,
      classification: DEFAULT_LAP_CLASSIFICATION,
      quality: null,
      eligibility: null,
    });

    expect(await getLapById(lapId)).toMatchObject(expected);
    const metadata = (await getLaps("iracing")).find((row) => row.id === lapId);
    expect(metadata).toMatchObject({ ...expected, rawFrameCount: 0 });
    expect(metadata).not.toHaveProperty("telemetry");
    const session = (await getSessions("iracing")).find((row) => row.id === sessionId);
    expect(session).toMatchObject(expected);
  } finally {
    await deleteSession(sessionId);
  }
});
