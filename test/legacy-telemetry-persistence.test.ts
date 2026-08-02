import { expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { eq } from "drizzle-orm";
import {
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "../shared/telemetry-catalog";
import {
  TELEMETRY_DERIVATION_VERSION,
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
} from "../shared/telemetry-resolver";
import { db } from "../server/db";
import { laps } from "../server/db/schema";
import { compressTelemetry } from "../server/db/telemetry-codec";
import { deleteSession, getSessions, insertSession, updateSessionRawFile } from "../server/db/session-queries";
import { getLapById, getLapsByIds } from "../server/db/lap-read-queries";
import { insertLap } from "../server/db/lap-mutation-queries";
import { updateLapRawIndex } from "../server/db/lap-reprocessing-queries";
import { initServerGameAdapters } from "../server/games/init";
import { RealDbAdapter } from "../server/telemetry/pipeline-ports"
import { queryLapTelemetryBySemanticId } from "../server/telemetry/replay"
import type { TelemetryPacket, TelemetryVersionIdentity } from "../shared/types";
initServerGameAdapters();


const versionIdentity: TelemetryVersionIdentity = {
  catalogVersion: "catalog-test",
  catalogHash: "sha256:test",
  catalogSchemaVersion: "schema-test",
  parserVersion: "parser-test",
  resolverVersion: "resolver-test",
  derivationVersion: "derivation-test",
};

test("historical telemetry and version identity round-trip without raw offsets", async () => {
  const sessionId = await insertSession(
    990_202,
    991_202,
    "fm-2023",
    undefined,
    versionIdentity,
  );
  try {
    const lapId = await insertLap(
      sessionId,
      1,
      90.25,
      true,
      null,
      0,
      null,
      null,
      null,
      null,
      versionIdentity,
    );
    const packet = {
      gameId: "fm-2023",
      TimestampMS: 1234,
      Speed: 44.5,
      Brake: 0.25,
    } as TelemetryPacket;
    await db
      .update(laps)
      .set({ legacyTelemetry: compressTelemetry([packet]) })
      .where(eq(laps.id, lapId))
      .run();

    const detail = await getLapById(lapId);
    expect(detail?.telemetry).toHaveLength(1);
    expect(detail?.telemetry[0]).toMatchObject({
      gameId: "fm-2023",
      TimestampMS: 1234,
      Speed: 44.5,
      Brake: 0.25,
    });
    const replay = await queryLapTelemetryBySemanticId(lapId, ["motion.speed"]);
    expect(replay?.envelopes).toHaveLength(1);
    expect(replay?.envelopes[0]).toMatchObject({
      sessionId: String(sessionId),
      sequence: 0n,
      simulator: "fm-2023",
      recordedWith: versionIdentity,
      values: [
        {
          semanticId: "motion.speed",
          value: 44.5,
          mappingStatus: "direct",
          state: "ok",
        },
      ],
      rawReference: {
        objectId: `lap:${lapId}:legacy-telemetry`,
      },
    });
    expect(replay?.envelopes[0].rawReference?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(detail).toMatchObject(versionIdentity);

    const session = (await getSessions("fm-2023")).find((row) => row.id === sessionId);
    expect(session).toMatchObject(versionIdentity);
  } finally {
    await deleteSession(sessionId);
  }
});
test("legacy telemetry backs every failed raw replay path and survives reprocess", async () => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const missingRawFile =
    `${process.env.DATA_DIR ?? "."}/legacy-fallback-missing-${unique}.bin`;
  const parseErrorRawFile =
    `${process.env.DATA_DIR ?? "."}/legacy-fallback-error-${unique}.bin`;
  const zeroPacketRawFile =
    `${process.env.DATA_DIR ?? "."}/legacy-fallback-empty-${unique}.bin`;
  const packet = {
    gameId: "fm-2023",
    TimestampMS: 4321,
    Speed: 55.5,
    Brake: 0.5,
  } as TelemetryPacket;
  const legacyTelemetry = compressTelemetry([packet]);
  const sessionId = await insertSession(990_206, 991_206, "fm-2023");
  try {
    await updateSessionRawFile(sessionId, missingRawFile, "test-detector");
    const lapId = await insertLap(
      sessionId,
      1,
      91.5,
      true,
      12,
      1,
    );
    await db
      .update(laps)
      .set({ legacyTelemetry })
      .where(eq(laps.id, lapId))
      .run();

    const fromMissingFile = await getLapById(lapId);
    expect(fromMissingFile?.telemetry).toEqual([packet]);
    expect(fromMissingFile?.parseError).toBeUndefined();

    await Bun.write(parseErrorRawFile, Buffer.alloc(16));
    await updateSessionRawFile(sessionId, parseErrorRawFile, "test-detector");
    await updateLapRawIndex(
      lapId,
      1000,
      1,
      91.5,
      true,
      null,
      null,
    );
    const fromParseError = await getLapById(lapId);
    expect(fromParseError?.telemetry).toEqual([packet]);
    expect(fromParseError?.parseError).toBeUndefined();

    await Bun.write(zeroPacketRawFile, Buffer.alloc(16));
    await updateSessionRawFile(sessionId, zeroPacketRawFile, "test-detector");
    await updateLapRawIndex(
      lapId,
      12,
      1,
      91.5,
      true,
      null,
      null,
    );
    const fromZeroPacketParse = await getLapById(lapId);
    expect(fromZeroPacketParse?.telemetry).toEqual([packet]);
    expect(fromZeroPacketParse?.parseError).toBeUndefined();

    await updateLapRawIndex(
      lapId,
      12,
      1,
      91.5,
      true,
      null,
      null,
    );
    const batch = await getLapsByIds([lapId]);
    expect(batch).toHaveLength(1);
    expect(batch[0].telemetry).toEqual([packet]);
    expect(batch[0].parseError).toBeUndefined();

    const retained = await db
      .select({ legacyTelemetry: laps.legacyTelemetry })
      .from(laps)
      .where(eq(laps.id, lapId))
      .get();
    expect(retained?.legacyTelemetry).toEqual(legacyTelemetry);
  } finally {
    await deleteSession(sessionId);
    for (const rawFile of [parseErrorRawFile, zeroPacketRawFile]) {
      try {
        unlinkSync(rawFile);
      } catch {}
    }
  }
});


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
