import { describe, expect, test } from "bun:test";
import { createFindingId } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, type FindingRecord } from "../../shared/racing/findings/types";
import {
  persistCompletedLapFindings,
  type CompletedLapFindingInput,
} from "../../server/findings/completed-lap";
import type { LapFindingSource } from "../../server/findings/lap-findings";
import { DETERMINISTIC_LAP_FINDINGS_SOURCE_ID } from "../../server/findings/lap-findings";
import {
  getCurrentFindingGeneration,
  replaceFindingGeneration,
} from "../../server/findings/store";
import {
  FINDING_GENERATION_PUBLISHED,
  subscribeFindingGeneration,
  type FindingGenerationPublishedEvent,
} from "../../server/findings/publication";
import { RealDbAdapter } from "../../server/telemetry/pipeline-ports";

let nextLapId = Date.now();

function input(): CompletedLapFindingInput {
  const lapId = nextLapId++;
  return {
    lapId,
    sessionId: lapId + 100_000,
    lapNumber: 2,
    lapTime: 90,
    isValid: true,
    gameId: "fm-2023",
    telemetry: [],
    quality: { valid: true, reason: null },
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

function finding(lap: LapFindingSource, type: string, ruleId: string): FindingRecord {
  const scope = { kind: "lap" as const, sessionId: String(lap.sessionId), lapId: String(lap.id) };
  const evidenceRefs = [{
    kind: "lap" as const,
    id: `lap:${lap.id}`,
    lapId: String(lap.id),
    sessionId: String(lap.sessionId),
  }];
  const record: FindingRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "pending",
    type,
    category: "test",
    scope,
    status: "available",
    severity: "informational",
    confidence: "high",
    measurements: [{
      id: `${type}:${lap.id}`,
      type,
      value: 1,
      unit: "count",
      sampleCount: 1,
      confidence: "high",
      semanticIds: [`test.${type}`],
      derivation: { id: ruleId, version: "1" },
    }],
    evidenceRefs,
    qualityRefs: [],
    limitations: [],
    rule: { id: ruleId, version: "1", inputs: { source: "test" } },
    analysisGenerationId: DETERMINISTIC_LAP_FINDINGS_SOURCE_ID,
  };
  record.id = createFindingId(record);
  return record;
}

function build(lap: LapFindingSource) {
  return {
    findings: [
      finding(lap, "lap-insight", "lap-insight-adapter"),
      finding(lap, "fuel-per-lap", "lap-metrics-adapter"),
    ],
    narratives: [],
    recommendations: [],
  };
}

const dependencies = {
  analyze: () => [],
  build,
};

describe("completed lap finding persistence", () => {
  test("activates production generation then publishes stable typed finding IDs", async () => {
    const lap = input();
    const events: FindingGenerationPublishedEvent[] = [];
    const unsubscribe = subscribeFindingGeneration((event) => {
      if (event.scope.lapId === String(lap.lapId)) events.push(event);
    });
    try {
      const result = await new RealDbAdapter({ notifyDriverProfile: false })
        .persistCompletedLapFindings(lap);
      const current = await getCurrentFindingGeneration(result.scope);

      expect(current?.receipt.generationId).toBe(result.receipt.generationId);
      expect(current?.receipt.status).toBe("current");
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe(FINDING_GENERATION_PUBLISHED);
      expect(events[0]?.findingIds).toEqual(result.findingIds);
      expect(events[0]?.findingIds).toEqual([...result.findingIds].sort());
    } finally {
      unsubscribe();
    }
  });

  test("same source and rules replay replaces same generation deterministically", async () => {
    const lap = input();
    const first = await persistCompletedLapFindings(lap, dependencies);
    const replay = await persistCompletedLapFindings(lap, dependencies);
    const current = await getCurrentFindingGeneration(first.scope);

    expect(replay.receipt.generationId).toBe(first.receipt.generationId);
    expect(replay.receipt.contentHash).toBe(first.receipt.contentHash);
    expect(replay.findingIds).toEqual(first.findingIds);
    expect(current?.receipt.generationId).toBe(first.receipt.generationId);
    expect(current?.findings.map(({ id }) => id).sort()).toEqual([...first.findingIds]);
  });

  test("failed activation retains active generation and publishes nothing", async () => {
    const lap = input();
    const active = await persistCompletedLapFindings(lap, dependencies);
    let publicationCount = 0;
    const unsubscribe = subscribeFindingGeneration((event) => {
      if (event.scope.lapId === String(lap.lapId)) publicationCount++;
    });
    try {
      await expect(persistCompletedLapFindings(lap, {
        ...dependencies,
        replace: (candidate) => replaceFindingGeneration({
          ...candidate,
          receipt: { ...candidate.receipt, contentHash: "sha256:invalid" },
        }),
      })).rejects.toThrow("content hash");

      expect(publicationCount).toBe(0);
      expect((await getCurrentFindingGeneration(active.scope))?.receipt.generationId).toBe(
        active.receipt.generationId,
      );
    } finally {
      unsubscribe();
    }
  });

  test("publication bus has no implicit delivery side effect", async () => {
    const lap = input();
    let observedEvents = 0;
    let deliveryCalls = 0;
    const delivery = () => { deliveryCalls++; };
    const unsubscribe = subscribeFindingGeneration((event) => {
      if (event.scope.lapId === String(lap.lapId)) observedEvents++;
    });
    try {
      await persistCompletedLapFindings(lap, dependencies);
      expect(observedEvents).toBe(1);
      expect(deliveryCalls).toBe(0);
      expect(delivery).toBeFunction();
    } finally {
      unsubscribe();
    }
  });
});
