import { describe, expect, test } from "bun:test";

import { canonicalJson } from "../../shared/core/canonical-json";
import {
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  AnalysisProvenanceReceiptSchema,
  AnalysisReceiptFailureSchema,
  AnalysisRebuildPreviewSchema,
  AnalysisStatusSchema,
} from "../../shared/racing/provenance/contracts";

const receipt = {
  receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
  generationId: "analysis-generation:test",
  artifactSetId: "analysis-set:test",
  artifactSetType: "session_analysis" as const,
  generation: 1,
  lifecycle: "active" as const,
  sessionId: 1,
  participantId: null,
  evidence: {
    kind: "raceiq-raw" as const,
    originalSourceKind: "raceiq-raw" as const,
    objectId: "session:1:raw-capture",
    contentHash: `sha256:${"a".repeat(64)}`,
    byteSize: 12,
    formatVersion: "raceiq-session-framing-v1",
    recordCounts: { laps: 1 },
  },
  telemetryVersion: {
    catalogVersion: "catalog",
    catalogHash: "hash",
    catalogSchemaVersion: "1",
    parserVersion: "parser",
    resolverVersion: "resolver",
    derivationVersion: "derivation",
  },
  analysisComponents: [{ id: "quality", version: "1", schemaVersion: "1" }],
  configuration: { hash: `sha256:${"b".repeat(64)}`, effective: { threshold: 1 } },
  context: {
    gameId: "iracing",
    trackId: null,
    layoutId: null,
    trackDefinitionHash: null,
    cornerDefinitionHash: null,
  },
  sourceFidelity: { profileVersion: null, decisions: [] },
  outputs: [{
    name: "laps",
    artifactType: "laps" as const,
    schemaVersion: "lap-analysis-v1",
    count: 1,
    contentHash: `sha256:${"c".repeat(64)}`,
    timeCoverageMs: null,
    lapCoverage: { start: 1, end: 1 },
    participantCoverage: null,
    trackDistanceCoverageM: null,
  }],
  canonicalInventory: null,
  warnings: [],
  unsupportedFields: [],
  rebuildCapability: {
    mode: "exact" as const,
    sourceKind: "raceiq-raw" as const,
    rebuildableArtifacts: ["laps" as const],
    unavailableArtifacts: [],
    limitations: [],
  },
  verification: [{ id: "storage_state" as const, status: "passed" as const, details: "ok" }],
  contractHash: `sha256:${"d".repeat(64)}`,
  startedAt: "2026-08-20T00:00:00.000Z",
  completedAt: "2026-08-20T00:00:01.000Z",
  activatedAt: "2026-08-20T00:00:01.000Z",
};

describe("analysis provenance contracts", () => {
  test("canonical JSON ignores object key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  test("strict receipt schema accepts complete receipt and rejects unknown fields", () => {
    expect(AnalysisProvenanceReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => AnalysisProvenanceReceiptSchema.parse({ ...receipt, unexpected: true })).toThrow();
  });
  test("validates status and preview DTOs plus malformed hashes", () => {
    const status = {
      status: "current" as const,
      staleReasons: [],
      activeGeneration: {
        generationId: receipt.generationId,
        generation: receipt.generation,
        lifecycle: receipt.lifecycle,
        receiptSchemaVersion: receipt.receiptSchemaVersion,
        completedAt: receipt.completedAt,
        activatedAt: receipt.activatedAt,
      },
      latestAttempt: null,
      capability: receipt.rebuildCapability,
      receipt,
      failure: null,
    };
    expect(AnalysisStatusSchema.parse(status)).toEqual(status);
    expect(AnalysisRebuildPreviewSchema.parse({
      sessionId: receipt.sessionId,
      status,
      selectedSource: "raceiq-raw",
      outputsReplaced: ["laps"],
      sourceAvailable: true,
      capability: receipt.rebuildCapability,
      limitations: [],
    })).toMatchObject({ selectedSource: "raceiq-raw" });
    expect(() => AnalysisProvenanceReceiptSchema.parse({
      ...receipt,
      evidence: { ...receipt.evidence, contentHash: "sha256:BAD" },
    })).toThrow();
  });

  test("failure schema keeps support-safe failure shape", () => {
    expect(AnalysisReceiptFailureSchema.parse({
      code: "rebuild_interrupted",
      message: "Analysis rebuild was interrupted before activation",
      failedAt: "2026-08-20T00:00:01.000Z",
      checks: [{ id: "storage_state", status: "failed", details: "not activated" }],
    })).toMatchObject({ code: "rebuild_interrupted" });
  });
});
