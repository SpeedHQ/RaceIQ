import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ManifestSchema } from "../src/contract";

test("lap manifests preserve original identity, source coverage, and native actor evidence", () => {
  const provenance = {
    lapGuid: "0194d2b5-1a00-7000-8000-000000000001",
    originalActivityId: "0194d2b5-1a00-7000-8000-000000000002",
    driverAttribution: "Mixed" as const,
    driverAttributionStints: [{
      gameId: "iracing" as const,
      source: "iracing-sdk-session-info",
      sessionId: "session-1",
      startMs: 10,
      endMs: 20,
      evidenceValidUntilMs: 20,
      clockDomain: "session-clock",
      actor: {
        gameId: "iracing" as const,
        source: "iracing-sdk-session-info",
        actorId: "user-42",
        bindingScope: "installation" as const,
        sessionId: "session-1",
        clockDomain: "session-clock",
        observedAtMs: 10,
      },
      attribution: "Self" as const,
      bindingRevision: 3,
    }, {
      gameId: "iracing" as const,
      source: "iracing-sdk-session-info",
      sessionId: "session-1",
      startMs: 20,
      endMs: null,
      evidenceValidUntilMs: 30,
      clockDomain: "session-clock",
      actor: null,
      attribution: "Unknown" as const,
      bindingRevision: null,
    }],
    sourceCoverageStart: 100,
    sourceCoverageEnd: 110,
    sourceCoverageComplete: true,
    sourceRevision: "source-revision-1",
  };
  const manifest = Schema.decodeSync(ManifestSchema)({
    version: 3,
    gameId: "iracing",
    sourceRevision: "manifest-revision-1",
    sourceByteLength: 1024,
    sourceRecordCount: 20,
    chunks: [{
      id: "lap-chunk",
      kind: "lap",
      lapId: "9",
      lapNumber: 1,
      path: "lap.bin",
      byteLength: 64,
      firstOrdinal: 100,
      recordCount: 10,
      sourceStart: 100,
      sourceEnd: 110,
      sourceByteStart: 512,
      sourceByteEnd: 1024,
      ownedFrameByteOffset: 12,
      ownedFrameCount: 10,
      ...provenance,
    }],
  });
  expect(manifest.chunks[0]).toMatchObject(provenance);
});

test("legacy lap manifests remain readable without identity or attribution claims", () => {
  const manifest = Schema.decodeSync(ManifestSchema)({
    version: 3,
    gameId: "acc",
    sourceRevision: "legacy",
    sourceByteLength: 32,
    sourceRecordCount: 1,
    chunks: [{
      id: "legacy-lap",
      kind: "lap",
      lapId: "1",
      lapNumber: 1,
      path: "lap.bin",
      byteLength: 32,
      firstOrdinal: 0,
      recordCount: 1,
      sourceStart: 0,
      sourceEnd: 1,
      sourceByteStart: 0,
      sourceByteEnd: 32,
      ownedFrameByteOffset: 12,
      ownedFrameCount: 1,
    }],
  });
  expect(manifest.chunks[0]?.lapGuid).toBeUndefined();
  expect(manifest.chunks[0]?.driverAttributionStints).toBeUndefined();
});
