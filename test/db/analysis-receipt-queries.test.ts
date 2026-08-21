import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { canonicalJson } from "../../shared/core/canonical-json";
import {
  ANALYSIS_ARTIFACT_SET_IDENTITY_SEED,
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  type AnalysisProvenanceReceipt,
} from "../../shared/racing/provenance/contracts";
import {
  activateAnalysisGeneration,
  beginAnalysisGeneration,
  failAnalysisGeneration,
  deriveAnalysisArtifactSetId,
} from "../../server/db/analysis-receipt-queries";
import { db } from "../../server/db/index";
import { laps, sessions } from "../../server/db/schema";
import { currentAnalysisContract } from "../../server/analysis-provenance/current-contract";
import { auditPersistedSessionAnalysis } from "../../server/analysis-provenance/inventory";
import { createPersistedSessionAnalysisReceipt } from "../../server/analysis-provenance/receipt";

const createdSessionIds: number[] = [];
const DIFFERENT_HASH = `sha256:${"f".repeat(64)}` as `sha256:${string}`;

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdSessionIds.length = 0;
});

async function createSession(): Promise<number> {
  const session = await db
    .insert(sessions)
    .values({
      gameId: "iracing",
      carOrdinal: 9_981_001,
      trackOrdinal: 9_981_002,
      source: "native-live",
    })
    .returning({ id: sessions.id })
    .get();
  if (!session) throw new Error("Session insert returned no row");
  createdSessionIds.push(session.id);
  await db.insert(laps).values({
    sessionId: session.id,
    lapNumber: 1,
    lapTime: 90,
    sectorTimes: [30, 29, 31],
  }).run();
  return session.id;
}

async function createAttemptWithReceipt(sessionId: number) {
  const contract = currentAnalysisContract("iracing");
  const attempt = await beginAnalysisGeneration({
    sessionId,
    artifactSetType: "session_analysis",
    contractHash: contract.contractHash,
    configurationHash: contract.configurationHash,
  });
  const receipt = await createPersistedSessionAnalysisReceipt(attempt, "iracing");
  return { attempt, receipt };
}

async function createActiveReceipt(sessionId: number): Promise<AnalysisProvenanceReceipt> {
  const { attempt, receipt } = await createAttemptWithReceipt(sessionId);
  await activateAnalysisGeneration({ generationId: attempt.generationId, receipt });
  return receipt;
}

describe("analysis receipt persistence", () => {
  test("keeps v1 artifact-set IDs tied to frozen identity seed, not receipt schema evolution", () => {
    const input = { sessionId: 987, participantId: null, artifactSetType: "session_analysis" as const };
    const simulatedFutureReceiptSchemaVersion = "analysis-receipt-v2";
    const legacyId = `analysis-set:${createHash("sha256").update(canonicalJson([
      "analysis-receipt-v1",
      input.sessionId,
      input.participantId,
      input.artifactSetType,
    ])).digest("hex")}`;

    const schemaCoupledId = `analysis-set:${createHash("sha256").update(canonicalJson([
      simulatedFutureReceiptSchemaVersion,
      input.sessionId,
      input.participantId,
      input.artifactSetType,
    ])).digest("hex")}`;
    expect(ANALYSIS_ARTIFACT_SET_IDENTITY_SEED).toBe("analysis-receipt-v1");
    expect(ANALYSIS_RECEIPT_SCHEMA_VERSION).toBe("analysis-receipt-v1");
    expect(deriveAnalysisArtifactSetId(input)).toBe(legacyId);
    expect(deriveAnalysisArtifactSetId(input)).not.toBe(schemaCoupledId);
  });

  test("rejects activation when pending or structured contract configuration identity differs", async () => {
    const sessionId = await createSession();
    const mutations: readonly [(receipt: AnalysisProvenanceReceipt) => AnalysisProvenanceReceipt, string][] = [
      [(receipt) => ({ ...receipt, contractHash: DIFFERENT_HASH }), "generation attempt"],
      [(receipt) => ({ ...receipt, configuration: { ...receipt.configuration, hash: DIFFERENT_HASH } }), "generation attempt"],
      [(receipt) => ({ ...receipt, analysisComponents: [...receipt.analysisComponents, { id: "unexpected", version: "1", schemaVersion: null }] }), "receipt content"],
      [(receipt) => ({ ...receipt, evidence: { ...receipt.evidence, contentHash: DIFFERENT_HASH } }), "generation attempt"],
      [(receipt) => ({ ...receipt, configuration: { ...receipt.configuration, effective: { mutated: true } } }), "receipt content"],
    ];

    for (const [mutate, message] of mutations) {
      const { attempt, receipt } = await createAttemptWithReceipt(sessionId);
      await expect(activateAnalysisGeneration({ generationId: attempt.generationId, receipt: mutate(receipt) }))
        .rejects.toThrow(message);
      await failAnalysisGeneration(attempt.generationId, {
        code: "activation_failed",
        message: "Expected activation rejection",
        failedAt: new Date().toISOString(),
        checks: [],
      });
    }
  });

  test("audit detects ordered sector-time mutation", async () => {
    const sessionId = await createSession();
    const receipt = await createActiveReceipt(sessionId);

    expect((await auditPersistedSessionAnalysis(receipt)).some((check) => check.status === "failed")).toBe(false);
    await db.update(laps).set({ sectorTimes: [30, 28.5, 31.5] }).where(eq(laps.sessionId, sessionId)).run();

    expect(await auditPersistedSessionAnalysis(receipt)).toContainEqual(expect.objectContaining({
      id: "storage_state",
      status: "failed",
      details: expect.stringContaining("laps"),
    }));
  });

  test("audit detects active generation-stamp mutation", async () => {
    const sessionId = await createSession();
    const receipt = await createActiveReceipt(sessionId);

    await db.update(laps).set({ analysisGenerationId: "analysis-generation:mutated" }).where(eq(laps.sessionId, sessionId)).run();

    expect(await auditPersistedSessionAnalysis(receipt)).toContainEqual(expect.objectContaining({
      id: "storage_state",
      status: "failed",
      details: expect.stringContaining("laps"),
    }));
  });
});
