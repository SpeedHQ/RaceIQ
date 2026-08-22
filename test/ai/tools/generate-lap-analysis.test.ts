import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type LapQualitySummary,
} from "../../../shared/racing/quality/contracts";
import { evaluateAllEligibility } from "../../../shared/racing/quality/policies";
import {
  type QualityCacheIdentity,
} from "../../../server/db/analysis-queries";
import type { FindingGenerationExpectation, StoredFindingGeneration } from "../../../server/findings/store";
import {
  generateLapAnalysis,
  type GenerateLapAnalysisDeps,
} from "../../../server/ai/generate-lap-analysis";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";

const validAnalysis = JSON.stringify({
  verdict: "Clean lap",
  pace: [],
  handling: [],
  corners: [],
  technique: [],
  setup: [],
});

const QUALITY_GENERATION = `sha256:${"a".repeat(64)}`;
const QUALITY_SOURCE_GENERATION = `sha256:${"b".repeat(64)}`;
const FINDING_GENERATION: StoredFindingGeneration = {
  scope: {
    kind: "lap",
    gameId: "fm-2023",
    sessionId: "17",
    lapId: "7",
  },
  receipt: {
    generationId: `sha256:${"c".repeat(64)}`,
    sourceId: "test-source",
    rule: { id: "test-rule", version: "1" },
    config: {},
    schemaVersion: "1",
    status: "current",
    findingCount: 0,
    availableCount: 0,
    unavailableCount: 0,
    indeterminateCount: 0,
    contentHash: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  findings: [],
};

function currentQuality(generation: string): LapQualitySummary {
  const measured = summarize(qualityPackets(100));
  return {
    ...measured,
    provenance: {
      ...measured.provenance,
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: QUALITY_SOURCE_GENERATION,
      outputGeneration: generation,
    },
  };
}

const quality = currentQuality(QUALITY_GENERATION);
const lap = {
  id: 7,
  sessionId: 17,
  lapTime: 91.2,
  gameId: "fm-2023" as const,
  trackOrdinal: 1,
  telemetry: [{ DistanceTraveled: 0 }, { DistanceTraveled: 100 }],
  qualityGeneration: QUALITY_GENERATION,
  qualitySchemaVersion: QUALITY_SCHEMA_VERSION,
  qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
  qualityConfigVersion: QUALITY_CONFIG_VERSION,
  quality,
  eligibility: {
    ...evaluateAllEligibility(quality),
    "corner-trace": {
      status: "eligible" as const,
      policyId: "corner-trace" as const,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      confidence: { level: "high" as const, score: 1 },
      reasons: [],
      evidenceIds: [],
    },
  },
};

function makeDeps(
  options: {
    cached?: string;
    generated?: string;
    generateError?: Error;
    onGenerate?: () => void;
    onSave?: (analysis: string, identity: QualityCacheIdentity, findingExpectation: FindingGenerationExpectation) => void;
  } = {},
): GenerateLapAnalysisDeps & {
  generateCalls: number;
  saves: string[];
  saveIdentities: QualityCacheIdentity[];
  readFindingKeys: FindingGenerationExpectation[];
  saveFindingKeys: FindingGenerationExpectation[];
} {
  let generateCalls = 0;
  const saves: string[] = [];
  const saveIdentities: QualityCacheIdentity[] = [];
  const readFindingKeys: FindingGenerationExpectation[] = [];
  const saveFindingKeys: FindingGenerationExpectation[] = [];
  let cached = options.cached
    ? {
        analysis: options.cached,
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0,
        durationMs: 3,
        model: "test-model",
      }
    : null;
  const deps: GenerateLapAnalysisDeps & {
    generateCalls: number;
    saves: string[];
    saveIdentities: QualityCacheIdentity[];
    readFindingKeys: FindingGenerationExpectation[];
    saveFindingKeys: FindingGenerationExpectation[];
  } = {
    generateCalls,
    saves,
    saveIdentities,
    readFindingKeys,
    saveFindingKeys,
    getLapById: async () => lap as never,
    getCorners: async () => [],
    detectCorners: () => [],
    getAnalysis: async (_lapId, findingExpectation) => {
      readFindingKeys.push(findingExpectation);
      return cached;
    },
    getCurrentFindingGeneration: async () => FINDING_GENERATION,
    saveAnalysis: async (_lapId, analysis, _usage, identity, findingExpectation) => {
      saves.push(analysis);
      saveIdentities.push(identity);
      saveFindingKeys.push(findingExpectation);
      options.onSave?.(analysis, identity, findingExpectation);
      cached = {
        analysis,
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0,
        durationMs: 3,
        model: "test-model",
      };
      return true;
    },
    loadSettings: () =>
      ({
        aiProvider: "local",
        aiModel: "test-model",
        localEndpoint: "http://localhost:1234/v1",
        unit: "metric",
        temperatureUnit: "C",
        language: "en",
        aiThinkingBudget: null,
      }) as never,
    resolveTrack: () => ({ segments: [], sectors: {} }) as never,
    buildAnalystPrompt: () => "prompt" as never,
    resolveAi: async () => ({
      feature: "analysis",
      provider: "local",
      model: "test-model",
      generateText: async () => {
        throw new Error("unused");
      },
      generateStructured: async () => {
        throw new Error("unused");
      },
    }),
    runAiStructured: async () => {
      generateCalls++;
      options.onGenerate?.();
      if (options.generateError) throw options.generateError;
      return {
        analysis: options.generated ?? validAnalysis,
        usage: {
          inputTokens: 4,
          outputTokens: 5,
          costUsd: 0,
          durationMs: 6,
          model: "test-model",
        },
      };
    },
  };
  Object.defineProperty(deps, "generateCalls", { get: () => generateCalls });
  return deps;
}

describe("generateLapAnalysis", () => {
  test("reuses valid cache without generation", async () => {
    const deps = makeDeps({ cached: validAnalysis });
    const result = await generateLapAnalysis(7, {}, deps);

    expect(result.cached).toBe(true);
    expect(result.analysis).toBe(validAnalysis);
    expect(deps.generateCalls).toBe(0);
    expect(deps.readFindingKeys).toMatchObject([{ generationId: FINDING_GENERATION.receipt.generationId, contentHash: FINDING_GENERATION.receipt.contentHash }]);
  });

  test("returns missing lap error", async () => {
    const deps = makeDeps();
    deps.getLapById = async () => null;

    const result = await generateLapAnalysis(404, {}, deps);

    expect(result.error).toBe("Lap not found");
    expect(deps.generateCalls).toBe(0);
  });

  test("does not build an AI prompt when finding generation is absent", async () => {
    const deps = makeDeps();
    deps.getCurrentFindingGeneration = async () => null;

    const result = await generateLapAnalysis(7, { regenerate: true }, deps);

    expect(result.error).toBe("No persisted finding generation for this lap");
    expect(deps.generateCalls).toBe(0);
  });

  test("returns preflight error before regeneration for a missing lap", async () => {
    const deps = makeDeps();
    deps.getLapById = async () => null;

    const result = await generateLapAnalysis(
      404,
      { regenerate: true, cacheOnly: true },
      deps,
    );

    expect(result.error).toBe("Lap not found");
    expect(result.analysis).toBeNull();
    expect(deps.generateCalls).toBe(0);
  });

  test("returns provider setup errors before opening regeneration stream", async () => {
    const deps = makeDeps();
    deps.resolveAi = async () => {
      throw new Error("provider unavailable");
    };

    const result = await generateLapAnalysis(
      7,
      { regenerate: true, cacheOnly: true, preflight: true },
      deps,
    );

    expect(result.error).toBe("provider unavailable");
    expect(result.analysis).toBeNull();
    expect(deps.generateCalls).toBe(0);
  });

  test("rejects malformed and schema-invalid output without caching", async () => {
    const malformedDeps = makeDeps({ generated: "not-json" });
    const malformed = await generateLapAnalysis(
      7,
      { regenerate: true },
      malformedDeps,
    );
    expect(malformed.error).toContain("invalid analysis structure");
    expect(malformedDeps.saves).toHaveLength(0);

    const schemaDeps = makeDeps({
      generated: JSON.stringify({ verdict: "missing required arrays" }),
    });
    const schemaInvalid = await generateLapAnalysis(
      7,
      { regenerate: true },
      schemaDeps,
    );
    expect(schemaInvalid.error).toContain("invalid analysis structure");
    expect(schemaDeps.saves).toHaveLength(0);
  });

  test("explicit regeneration bypasses valid cache", async () => {
    const deps = makeDeps({
      cached: validAnalysis,
      generated: JSON.stringify({
        verdict: "Regenerated",
        pace: [],
        handling: [],
        corners: [],
        technique: [],
        setup: [],
      }),
    });

    const result = await generateLapAnalysis(7, { regenerate: true }, deps);

    expect(result.cached).toBe(false);
    expect(JSON.parse(result.analysis!).verdict).toBe("Regenerated");
    expect(deps.generateCalls).toBe(1);
    expect(deps.saves).toHaveLength(1);
  });

  test("passes prompt-load quality identity to save after model generation", async () => {
    const loadedLap = {
      ...lap,
      quality: currentQuality(lap.qualityGeneration),
    };
    const deps = makeDeps({
      onGenerate: () => {
        loadedLap.qualityGeneration = "sha256:changed-during-model";
        loadedLap.quality.provenance.policyVersion = "changed-policy";
      },
    });
    deps.getLapById = async () => loadedLap as never;

    const result = await generateLapAnalysis(7, { regenerate: true }, deps);

    expect(result.error).toBeUndefined();
    expect(deps.saveIdentities).toEqual([
      {
        generation: QUALITY_GENERATION,
        policyVersion: "1",
      },
    ]);
    expect(deps.saveFindingKeys).toMatchObject([{ generationId: FINDING_GENERATION.receipt.generationId, contentHash: FINDING_GENERATION.receipt.contentHash }]);
  });

  test("rejects model output when save reports a stale prompt identity", async () => {
    const deps = makeDeps();
    deps.saveAnalysis = async () => false;

    const result = await generateLapAnalysis(7, { regenerate: true }, deps);

    expect(result.analysis).toBeNull();
    expect(result.error).toBe("Lap quality changed during analysis generation. Analysis not cached.");
  });

  test("rejects model output when finding generation changes before save", async () => {
    const deps = makeDeps();
    let readCount = 0;
    deps.getCurrentFindingGeneration = async () => {
      readCount++;
      return readCount === 1
        ? FINDING_GENERATION
        : {
            ...FINDING_GENERATION,
            receipt: {
              ...FINDING_GENERATION.receipt,
              generationId: `sha256:${"e".repeat(64)}`,
            },
          };
    };

    const result = await generateLapAnalysis(7, { regenerate: true }, deps);

    expect(result.analysis).toBeNull();
    expect(result.error).toBe("Lap findings changed during analysis generation. Analysis not cached.");
    expect(deps.saves).toHaveLength(0);
  });

  test("failed regeneration leaves prior valid cache untouched", async () => {
    const deps = makeDeps({
      cached: validAnalysis,
      generateError: new Error("provider unavailable"),
    });

    const result = await generateLapAnalysis(7, { regenerate: true }, deps);

    expect(result.error).toBe("provider unavailable");
    expect(deps.saves).toHaveLength(0);
    expect((await deps.getAnalysis!(7, {
      scope: { kind: "lap", gameId: "fm-2023", sessionId: "17", lapId: "7" },
      generationId: FINDING_GENERATION.receipt.generationId,
      contentHash: FINDING_GENERATION.receipt.contentHash,
    }))?.analysis).toBe(validAnalysis);
  });
});

test("uses every native sector in iRacing analysis context", async () => {
  let capturedSectors: unknown;
  const deps = Object.assign(makeDeps(), {
    getLapById: async () =>
      ({
        ...lap,
        gameId: "iracing",
        telemetry: Array.from({ length: 60 }, (_, index) => ({
          DistanceTraveled: index * 10,
          CurrentLap: index / 2,
          iracing: {
            lapDistancePct: index / 59,
            sectorStarts: [0, 0.34, 0.67],
          },
        })),
      }) as never,
    getGame: () => ({
      nativeSectors: true,
      getNativeSectorLayout: (packet: TelemetryPacket) => packet.iracing,
    }),
    computeNativeSectorTimeline: () => ({
      sectorCount: 6,
      times: [10, 11, 12, 13, 14, 15],
      boundaryIndices: [10, 20, 30, 40, 50],
      sectorStarts: [0, 0.17, 0.34, 0.51, 0.68, 0.84],
    }),
    resolveTrack: () => ({ segments: [], sectors: {} }),
    buildAnalystPrompt: (
      _lap: unknown,
      _telemetry: unknown,
      _corners: unknown,
      _unit: unknown,
      _temperatureUnit: unknown,
      _tune: unknown,
      _segments: unknown,
      _externalGuide: unknown,
      _language: unknown,
      sectors: unknown,
    ) => {
      capturedSectors = sectors;
      return "prompt";
    },
  });

  await generateLapAnalysis(7, { regenerate: true }, deps);

  expect(capturedSectors).toEqual({
    times: [10, 11, 12, 13, 14, 15],
    sectorStarts: [0, 0.17, 0.34, 0.51, 0.68, 0.84],
  });
});
