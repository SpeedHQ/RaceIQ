import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createFindingId } from "../../shared/racing/findings/identity";
import {
  FINDING_SCHEMA_VERSION,
  type FindingRecord,
  type FindingScope,
} from "../../shared/racing/findings/types";
import {
  activateFindingGeneration,
  createFindingGenerationReceipt,
  getCurrentFindingGeneration,
  getFindingGeneration,
  getLatestFindingGeneration,
  markCurrentFindingGenerationStale,
  replaceFindingGeneration,
  MAX_FINDING_GENERATION_STRUCTURED_BYTES,
  MAX_FINDING_STRUCTURED_BYTES,
  stageFindingGeneration,
  type FindingGenerationInput,
} from "../../server/findings/store";
import { db } from "../../server/db";
import { findingRecords, laps, sessions } from "../../server/db/schema";
import { deleteLap } from "../../server/db/lap-mutation-queries";

const RULE = { id: "store-test-rule", version: "1", inputs: {} } as const;

const createdSessionIds: number[] = [];

function scope(): FindingScope {
  return { kind: "session", gameId: "iracing", sessionId: `store-test-${crypto.randomUUID()}` };
}

async function createLap(): Promise<{ sessionId: number; lapId: number }> {
  const sessionId = (
    await db
      .insert(sessions)
      .values({ carOrdinal: 92_310_001, trackOrdinal: 92_310_002, gameId: "iracing" })
      .returning({ id: sessions.id })
      .get()
  ).id;
  createdSessionIds.push(sessionId);
  const lapId = (
    await db
      .insert(laps)
      .values({ sessionId, lapNumber: 1, lapTime: 90, isValid: true })
      .returning({ id: laps.id })
      .get()
  ).id;
  return { sessionId, lapId };
}

afterEach(async () => {
  for (const sessionId of createdSessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
});

function finding(
  findingScope: FindingScope,
  sourceId: string,
  evidenceId: string,
  value = 1,
): FindingRecord {
  const record: FindingRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "pending",
    type: "pace-observation",
    category: "pace",
    scope: findingScope,
    status: "available",
    severity: "informational",
    confidence: "high",
    measurements: [{
      id: `measurement-${evidenceId}`,
      type: "time-loss",
      value,
      unit: "s",
      sampleCount: 1,
      confidence: "high",
      semanticIds: [evidenceId],
      derivation: { id: "authoritative-adapter", version: "1" },
    }],
    evidenceRefs: [{ kind: "lap", id: evidenceId, lapId: evidenceId }],
    qualityRefs: [],
    limitations: [],
    rule: RULE,
    analysisGenerationId: sourceId,
    title: "Convenience prose is not persisted",
  };
  record.id = createFindingId(record);
  return record;
}

function generation(
  findingScope: FindingScope,
  generationId: string,
  sourceId: string,
  findings: readonly FindingRecord[],
): FindingGenerationInput {
  return {
    scope: findingScope,
    findings,
    receipt: createFindingGenerationReceipt({
      generationId,
      sourceId,
      rule: { id: RULE.id, version: RULE.version },
      config: { policy: "test" },
      schemaVersion: FINDING_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
    }, findings),
  };
}

describe("structured findings store", () => {
  test("stages and atomically activates a verified generation", async () => {
    const findingScope = scope();
    const sourceId = "source-success";
    const input = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-success"),
    ]);

    await stageFindingGeneration(input);
    expect(await getCurrentFindingGeneration(findingScope)).toBeNull();

    const receipt = await activateFindingGeneration(input.receipt.generationId);
    const current = await getCurrentFindingGeneration(findingScope);
    expect(receipt.status).toBe("current");
    expect(current?.receipt.contentHash).toBe(input.receipt.contentHash);
    expect(current?.findings).toHaveLength(1);
    expect(current?.findings[0]?.title).toBeUndefined();
  });

  test("persists heterogeneous finding rules under one pipeline receipt", async () => {
    const findingScope = scope();
    const sourceId = "source-mixed-rules";
    const insight = finding(findingScope, sourceId, "lap-insight");
    insight.rule = { id: "lap-insight-adapter", version: "2", inputs: { source: "insight" } };
    insight.id = createFindingId(insight);
    const metrics = finding(findingScope, sourceId, "lap-metrics");
    metrics.rule = { id: "lap-metrics-adapter", version: "3", inputs: { source: "metrics" } };
    metrics.id = createFindingId(metrics);
    const input = generation(
      findingScope,
      `generation-${crypto.randomUUID()}`,
      sourceId,
      [insight, metrics],
    );

    await replaceFindingGeneration(input);

    const current = await getCurrentFindingGeneration(findingScope);

    expect(current?.receipt.rule).toEqual({ id: RULE.id, version: RULE.version });
    expect(
      current?.findings
        .map((record) => `${record.rule.id}@${record.rule.version}`)
        .sort(),
    ).toEqual(["lap-insight-adapter@2", "lap-metrics-adapter@3"]);
  });

  test("keeps current generations separate for identical scopes in different games", async () => {
    const sessionId = `shared-session-${crypto.randomUUID()}`;
    const iracingScope: FindingScope = { kind: "session", gameId: "iracing", sessionId };
    const accScope: FindingScope = { kind: "session", gameId: "acc", sessionId };
    const iracingInput = generation(iracingScope, `generation-${crypto.randomUUID()}`, "source-iracing", [
      finding(iracingScope, "source-iracing", "lap-iracing"),
    ]);
    const accInput = generation(accScope, `generation-${crypto.randomUUID()}`, "source-acc", [
      finding(accScope, "source-acc", "lap-acc"),
    ]);

    await replaceFindingGeneration(iracingInput);
    await replaceFindingGeneration(accInput);

    expect((await getCurrentFindingGeneration(iracingScope))?.receipt.generationId).toBe(
      iracingInput.receipt.generationId,
    );
    expect((await getCurrentFindingGeneration(accScope))?.receipt.generationId).toBe(
      accInput.receipt.generationId,
    );
  });

  test("rejects oversized structured finding before generation hashing", () => {
    const findingScope = scope();
    const sourceId = "source-oversized-finding";
    const oversized = finding(findingScope, sourceId, "lap-oversized");
    oversized.rule = {
      ...oversized.rule,
      inputs: { payload: "x".repeat(MAX_FINDING_STRUCTURED_BYTES) },
    };
    oversized.id = createFindingId(oversized);

    expect(() => generation(
      findingScope,
      `generation-${crypto.randomUUID()}`,
      sourceId,
      [oversized],
    )).toThrow(`exceeds ${MAX_FINDING_STRUCTURED_BYTES} bytes`);
  });

  test("rejects aggregate generation serialization beyond fixed budget", () => {
    const findingScope = scope();
    const sourceId = "source-oversized-generation";
    const findings = Array.from({ length: 18 }, (_, index) => {
      const record = finding(findingScope, sourceId, `lap-generation-${index}`);
      record.rule = {
        ...record.rule,
        inputs: { payload: "x".repeat(120_000) },
      };
      record.id = createFindingId(record);
      return record;
    });

    expect(() => generation(
      findingScope,
      `generation-${crypto.randomUUID()}`,
      sourceId,
      findings,
    )).toThrow(`exceeds ${MAX_FINDING_GENERATION_STRUCTURED_BYTES} bytes`);
  });

  test("failed verification preserves prior active generation", async () => {
    const findingScope = scope();
    const sourceId = "source-rollback";
    const currentInput = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-current"),
    ]);
    await replaceFindingGeneration(currentInput);

    const failedInput = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-invalid"),
    ]);
    failedInput.receipt.contentHash = "sha256:not-the-content";

    await expect(replaceFindingGeneration(failedInput)).rejects.toThrow("content hash");
    expect((await getCurrentFindingGeneration(findingScope))?.receipt.generationId).toBe(
      currentInput.receipt.generationId,
    );
    expect((await getFindingGeneration(failedInput.receipt.generationId))?.receipt.status).toBe(
      "verification-failed",
    );
  });

  test("current reads reject stale status while latest reads retain stale generation", async () => {
    const findingScope = scope();
    const sourceId = "source-stale";
    const input = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-stale"),
    ]);
    await replaceFindingGeneration(input);

    const receipt = await markCurrentFindingGenerationStale(findingScope, "stale-rebuild-available");
    expect(receipt?.status).toBe("stale-rebuild-available");
    expect(await getCurrentFindingGeneration(findingScope)).toBeNull();
    expect((await getLatestFindingGeneration(findingScope))?.findings).toHaveLength(1);
  });

  test("marks active findings stale when authoritative source is missing", async () => {
    const findingScope = scope();
    const sourceId = "source-missing";
    const input = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-missing"),
    ]);
    await replaceFindingGeneration(input);

    const receipt = await markCurrentFindingGenerationStale(findingScope, "stale-source-missing");
    expect(receipt?.status).toBe("stale-source-missing");
    expect(await getCurrentFindingGeneration(findingScope)).toBeNull();
    expect((await getLatestFindingGeneration(findingScope))?.receipt.generationId).toBe(
      input.receipt.generationId,
    );
  });

  test("rejects same finding ID with materially different structured content", async () => {
    const findingScope = scope();
    const sourceId = "source-conflict";
    const original = finding(findingScope, sourceId, "lap-conflict", 1);
    const currentInput = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [original]);
    await replaceFindingGeneration(currentInput);

    const conflict = structuredClone(original);
    conflict.measurements[0]!.value = 2;
    const conflictingInput = generation(
      findingScope,
      `generation-${crypto.randomUUID()}`,
      sourceId,
      [conflict],
    );

    await expect(replaceFindingGeneration(conflictingInput)).rejects.toThrow(
      "Conflicting finding records share an ID",
    );
    expect((await getCurrentFindingGeneration(findingScope))?.findings[0]?.measurements[0]?.value).toBe(1);
  });

  test("activation replaces whole scope without mixed active generations", async () => {
    const findingScope = scope();
    const sourceId = "source-replace";
    const first = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-old"),
    ]);
    await replaceFindingGeneration(first);

    const second = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-new-a"),
      finding(findingScope, sourceId, "lap-new-b"),
    ]);
    await stageFindingGeneration(second);
    expect((await getCurrentFindingGeneration(findingScope))?.receipt.generationId).toBe(first.receipt.generationId);
    await activateFindingGeneration(second.receipt.generationId);

    const current = await getCurrentFindingGeneration(findingScope);
    expect(current?.receipt.generationId).toBe(second.receipt.generationId);
    expect(current?.findings.map((record) => record.evidenceRefs[0]?.id).sort()).toEqual([
      "lap-new-a",
      "lap-new-b",
    ]);
    expect(await getFindingGeneration(first.receipt.generationId)).toBeNull();
  });

  test("rejects cross-scope generation ID reuse without replacing first owner", async () => {
    const firstScope = scope();
    const secondScope = scope();
    const sourceId = "source-scope-owner";
    const generationId = `generation-${crypto.randomUUID()}`;
    const first = generation(firstScope, generationId, sourceId, [
      finding(firstScope, sourceId, "lap-first-owner"),
    ]);
    await replaceFindingGeneration(first);
    const firstActive = await getCurrentFindingGeneration(firstScope);
    expect(firstActive?.receipt.generationId).toBe(generationId);

    const reused = generation(secondScope, generationId, sourceId, [
      finding(secondScope, sourceId, "lap-second-owner"),
    ]);
    await expect(replaceFindingGeneration(reused)).rejects.toThrow("different semantic scope");

    expect(await getCurrentFindingGeneration(firstScope)).toEqual(firstActive);
    expect(await getCurrentFindingGeneration(secondScope)).toBeNull();
    expect((await getFindingGeneration(generationId))?.scope).toEqual(firstScope);
  });

  test("deterministic replay replaces same generation regardless record order", async () => {
    const findingScope = scope();
    const sourceId = "source-replay";
    const generationId = `generation-${crypto.randomUUID()}`;
    const records = [
      finding(findingScope, sourceId, "lap-replay-a"),
      finding(findingScope, sourceId, "lap-replay-b"),
    ];
    const first = generation(findingScope, generationId, sourceId, records);
    await replaceFindingGeneration(first);
    const canonicalFindings = (await getCurrentFindingGeneration(findingScope))?.findings;
    expect(canonicalFindings).toHaveLength(2);

    const replay = generation(findingScope, generationId, sourceId, [...records].reverse());
    expect(replay.receipt.contentHash).toBe(first.receipt.contentHash);
    await replaceFindingGeneration(replay);

    const current = await getCurrentFindingGeneration(findingScope);
    expect(current?.receipt.generationId).toBe(generationId);
    expect(current?.receipt.contentHash).toBe(first.receipt.contentHash);
    expect(current?.findings).toEqual(canonicalFindings);
  });

  test("lap deletion cascades only its owned finding generation", async () => {
    const { sessionId, lapId } = await createLap();
    const lapScope: FindingScope = {
      kind: "lap",
      gameId: "iracing",
      sessionId: String(sessionId),
      lapId: String(lapId),
    };
    const sessionScope = scope();
    const lapInput = generation(lapScope, `generation-${crypto.randomUUID()}`, "source-lap-owned", [
      finding(lapScope, "source-lap-owned", "lap-owned"),
    ]);
    const sessionInput = generation(sessionScope, `generation-${crypto.randomUUID()}`, "source-session-owned", [
      finding(sessionScope, "source-session-owned", "session-owned"),
    ]);

    await replaceFindingGeneration(lapInput);
    await replaceFindingGeneration(sessionInput);

    expect(await deleteLap(lapId)).toBe(true);
    expect(await getFindingGeneration(lapInput.receipt.generationId)).toBeNull();
    expect(
      await db
        .select({ generationId: findingRecords.generationId })
        .from(findingRecords)
        .where(eq(findingRecords.generationId, lapInput.receipt.generationId)),
    ).toEqual([]);
    expect(await getCurrentFindingGeneration(lapScope)).toBeNull();
    expect((await getCurrentFindingGeneration(sessionScope))?.receipt.generationId).toBe(
      sessionInput.receipt.generationId,
    );
  });

  test("rejects non-numeric lap scope IDs before persistence", async () => {
    const invalidScope: FindingScope = {
      kind: "lap",
      gameId: "iracing",
      sessionId: "invalid-lap-scope",
      lapId: "lap-not-numeric",
    };
    const input = generation(invalidScope, `generation-${crypto.randomUUID()}`, "source-invalid-lap", [
      finding(invalidScope, "source-invalid-lap", "lap-invalid"),
    ]);

    await expect(stageFindingGeneration(input)).rejects.toThrow("positive numeric lap ID");
  });
});
