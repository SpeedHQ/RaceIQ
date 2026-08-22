import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";
import { canonicalJson, createFindingId } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, type FindingRecord } from "../../shared/racing/findings/types";
import {
  persistCompletedLapFindings,
  type CompletedLapFindingInput,
} from "../../server/findings/completed-lap";
import type { LapFindingSource } from "../../server/findings/lap-findings";
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
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";

const TEST_QUALITY = finalizeLapQualityGeneration(
  summarize(qualityPackets(100)),
  `sha256:${"c".repeat(64)}`,
  { lapNumber: 2, rawByteOffset: 0, rawFrameCount: 100 },
).quality;
let nextLapId = Date.now();
const createdSessionIds: number[] = [];

async function storedInput(): Promise<CompletedLapFindingInput> {
  const lap = input();
  await db.insert(sessions).values({
    id: lap.sessionId,
    carOrdinal: 1,
    trackOrdinal: 1,
    gameId: lap.gameId,
  }).run();
  createdSessionIds.push(lap.sessionId);
  await db.insert(laps).values({
    id: lap.lapId,
    sessionId: lap.sessionId,
    lapNumber: lap.lapNumber,
    lapTime: lap.lapTime,
    isValid: lap.isValid,
  }).run();
  return lap;
}

afterEach(async () => {
  for (const sessionId of createdSessionIds.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
});


function input(): CompletedLapFindingInput {
  const lapId = nextLapId++;
  return {
    lapId,
    sessionId: lapId + 100_000,
    lapNumber: 2,
    lapTime: 90,
    isValid: true,
    gameId: "fm-2023",
    quality: TEST_QUALITY,
    recordingQuality: { valid: true, reason: null },
    analysisGenerationId: "analysis-generation-1",
    versionIdentity: TEST_QUALITY.versionIdentity,
    telemetry: [],
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}
function expectedSourceId(lap: CompletedLapFindingInput): string {
  const provenance = canonicalJson({
    analysisGenerationId: lap.analysisGenerationId ?? null,
    qualityGeneration: lap.quality.provenance.outputGeneration,
    versionIdentity: lap.versionIdentity,
  });
  return `sha256:${createHash("sha256").update(provenance).digest("hex")}`;
}


function finding(
  lap: LapFindingSource,
  type: string,
  ruleId: string,
  analysisGenerationId: string,
  measurementValue = 1,
): FindingRecord {
  const scope = { kind: "lap" as const, gameId: lap.gameId, sessionId: String(lap.sessionId), lapId: String(lap.id) };
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
      value: measurementValue,
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
    analysisGenerationId,
  };
  record.id = createFindingId(record);
  return record;
}

function build(
  lap: LapFindingSource,
  _insights: readonly unknown[],
  _recordingQuality: unknown,
  analysisGenerationId: string,
  measurementValue = 1,
) {
  return {
    findings: [
      finding(lap, "lap-insight", "lap-insight-adapter", analysisGenerationId, measurementValue),
      finding(lap, "fuel-per-lap", "lap-metrics-adapter", analysisGenerationId, measurementValue),
    ],
    narratives: [],
    recommendations: [],
  };
}

const dependencies = {
  analyze: () => [],
  build,
};

const identityDependencies = {
  ...dependencies,
  replace: async ({ receipt }: Parameters<typeof replaceFindingGeneration>[0]) => ({
    ...receipt,
    status: "current" as const,
    activatedAt: receipt.createdAt,
  }),
  publish: () => {},
};

describe("completed lap finding persistence", () => {
  test("activates production generation then publishes stable typed finding IDs", async () => {
    const lap = await storedInput();
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

  test("passes current quality into analysis and recording quality into adapters", async () => {
    const lap = input();
    let analyzedQuality: CompletedLapFindingInput["quality"] | null = null;
    let adapterRecordingQuality: CompletedLapFindingInput["recordingQuality"] | null = null;
    await persistCompletedLapFindings(lap, {
      ...identityDependencies,
      analyze: (_telemetry, _gameId, quality) => {
        analyzedQuality = quality ?? null;
        return [];
      },
      build: (source, insights, recordingQuality, analysisGenerationId) => {
        adapterRecordingQuality = recordingQuality;
        return build(source, insights, recordingQuality, analysisGenerationId);
      },
    });

    expect(Object.is(analyzedQuality, lap.quality)).toBe(true);
    expect(Object.is(adapterRecordingQuality, lap.recordingQuality)).toBe(true);
  });

  test("hashes every provenance input into stable adapter and receipt identity", async () => {
    const lap = input();
    const base = await persistCompletedLapFindings(lap, identityDependencies);
    const game = await persistCompletedLapFindings({ ...lap, gameId: "acc" }, identityDependencies);
    const qualityInput = {
      ...lap,
      quality: {
        ...lap.quality,
        provenance: { ...lap.quality.provenance, outputGeneration: "quality-generation-2" },
      },
    };
    const quality = await persistCompletedLapFindings(qualityInput, identityDependencies);
    const analysisInput = { ...lap, analysisGenerationId: "analysis-generation-2" };
    const nullableAnalysisInput = { ...lap, analysisGenerationId: null };
    const nullableAnalysis = await persistCompletedLapFindings(nullableAnalysisInput, identityDependencies);
    const analysis = await persistCompletedLapFindings(analysisInput, identityDependencies);
    const telemetryFields = [
      "catalogVersion",
      "catalogHash",
      "catalogSchemaVersion",
      "parserVersion",
      "resolverVersion",
      "derivationVersion",
    ] as const;

    expect(base.receipt.sourceId).toBe(expectedSourceId(lap));
    expect(game.receipt.sourceId).toBe(base.receipt.sourceId);
    expect(game.findingIds).not.toEqual(base.findingIds);
    expect(game.receipt.generationId).not.toBe(base.receipt.generationId);
    expect(quality.receipt.sourceId).toBe(expectedSourceId(qualityInput));
    expect(quality.receipt.sourceId).not.toBe(base.receipt.sourceId);
    expect(quality.findingIds).not.toEqual(base.findingIds);
    expect(analysis.receipt.sourceId).toBe(expectedSourceId(analysisInput));
    expect(analysis.receipt.sourceId).not.toBe(base.receipt.sourceId);
    expect(nullableAnalysis.receipt.sourceId).toBe(expectedSourceId(nullableAnalysisInput));
    expect(nullableAnalysis.receipt.sourceId).not.toBe(base.receipt.sourceId);
    expect(nullableAnalysis.findingIds).not.toEqual(base.findingIds);
    expect(analysis.findingIds).not.toEqual(base.findingIds);

    for (const field of telemetryFields) {
      const changedInput = {
        ...lap,
        versionIdentity: {
          ...lap.versionIdentity,
          [field]: `${lap.versionIdentity[field]}-next`,
        },
      };
      const changed = await persistCompletedLapFindings(changedInput, identityDependencies);
      expect(changed.receipt.sourceId).toBe(expectedSourceId(changedInput));
      expect(changed.receipt.sourceId).not.toBe(base.receipt.sourceId);
      expect(changed.findingIds).not.toEqual(base.findingIds);
    }

    expect(base.receipt.config).toMatchObject({
      gameId: lap.gameId,
      analysisGenerationId: lap.analysisGenerationId,
      qualityGeneration: lap.quality.provenance.outputGeneration,
      versionIdentity: lap.versionIdentity,
    });
  });

  test("same source and rules replay replaces same generation deterministically", async () => {
    const lap = await storedInput();
    const first = await persistCompletedLapFindings(lap, dependencies);
    const replay = await persistCompletedLapFindings(lap, dependencies);
    const current = await getCurrentFindingGeneration(first.scope);

    expect(replay.receipt.sourceId).toBe(expectedSourceId(lap));
    expect(replay.receipt.generationId).toBe(first.receipt.generationId);
    expect(replay.receipt.contentHash).toBe(first.receipt.contentHash);
    expect(replay.findingIds).toEqual(first.findingIds);
    expect(current?.receipt.generationId).toBe(first.receipt.generationId);
    expect(current?.findings.map(({ id }) => id).sort()).toEqual([...first.findingIds]);
  });

  test("legitimate provenance rebuild replaces changed material without stored conflict", async () => {
    const lap = await storedInput();
    const first = await persistCompletedLapFindings(lap, dependencies);
    const rebuiltInput = {
      ...lap,
      quality: {
        ...lap.quality,
        provenance: { ...lap.quality.provenance, outputGeneration: "quality-generation-rebuilt" },
      },
    };
    const rebuilt = await persistCompletedLapFindings(rebuiltInput, {
      ...dependencies,
      build: (source, insights, recordingQuality, sourceId) =>
        build(source, insights, recordingQuality, sourceId, 2),
    });
    const current = await getCurrentFindingGeneration(first.scope);

    expect(rebuilt.receipt.sourceId).toBe(expectedSourceId(rebuiltInput));
    expect(rebuilt.receipt.sourceId).not.toBe(first.receipt.sourceId);
    expect(rebuilt.receipt.generationId).not.toBe(first.receipt.generationId);
    expect(rebuilt.findingIds).not.toEqual(first.findingIds);
    expect(current?.receipt.generationId).toBe(rebuilt.receipt.generationId);
    expect(current?.findings.map(({ id }) => id).sort()).toEqual([...rebuilt.findingIds]);
    expect(current?.findings.map(({ measurements }) => measurements[0]?.value)).toEqual([2, 2]);
  });

  test("failed activation retains active generation and publishes nothing", async () => {
    const lap = await storedInput();
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
    const lap = await storedInput();
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
