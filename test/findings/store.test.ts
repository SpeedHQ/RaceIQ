import { describe, expect, test } from "bun:test";
import { createFindingId } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, type FindingRecord, type FindingScope } from "../../shared/racing/findings/types";
import {
  activateFindingGeneration,
  createFindingGenerationReceipt,
  getCurrentFindingGeneration,
  getFindingGeneration,
  markCurrentFindingGenerationStale,
  replaceFindingGeneration,
  stageFindingGeneration,
  type FindingGenerationInput,
} from "../../server/findings/store";

const RULE = { id: "store-test-rule", version: "1", inputs: {} } as const;

function scope(): FindingScope {
  return { kind: "session", sessionId: `store-test-${crypto.randomUUID()}` };
}

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

  test("keeps stale current findings readable while rebuild is available", async () => {
    const findingScope = scope();
    const sourceId = "source-stale";
    const input = generation(findingScope, `generation-${crypto.randomUUID()}`, sourceId, [
      finding(findingScope, sourceId, "lap-stale"),
    ]);
    await replaceFindingGeneration(input);

    const receipt = await markCurrentFindingGenerationStale(findingScope, "stale-rebuild-available");
    expect(receipt?.status).toBe("stale-rebuild-available");
    expect((await getCurrentFindingGeneration(findingScope))?.findings).toHaveLength(1);
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
    expect((await getCurrentFindingGeneration(findingScope))?.receipt.generationId).toBe(
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
});
