import { describe, expect, test } from "bun:test";

import {
  getLapAnalysisToolFor,
  parseCachedLapAnalysis,
} from "../../../src/mastra/tools/lap-analysis";
import { buildCompareChatSystemPrompt } from "@raceiq/backend-core/ai/compare-chat-prompt";
import { setupContextForLap } from "../../../src/ai/lap-setup-context";

const lap = {
  id: 1,
  lapNumber: 4,
  lapTime: 91.2,
  isValid: true,
  gameId: "fm-2023" as const,
};

const validAnalysis = JSON.stringify({
  verdict: "clean",
  pace: [],
  handling: [],
  corners: [],
  technique: [],
  setup: [],
});

type LapResult = {
  available: boolean;
  lapId: number;
  analysis?: unknown;
  readable: string;
  model?: string;
  error?: string;
};

function isLapResult(value: unknown): value is LapResult {
  if (!value || typeof value !== "object") return false;
  const result = value as {
    available?: unknown;
    lapId?: unknown;
    readable?: unknown;
  };
  return (
    typeof result.available === "boolean" &&
    typeof result.lapId === "number" &&
    typeof result.readable === "string"
  );
}

const comparison = {
  timeDelta: [0, 0.4],
  distances: [0, 100],
  cornerDeltas: [],
} as never;

describe("lap analysis retrieval contract", () => {
  test("parses cached structured analysis for tool output", () => {
    const result = parseCachedLapAnalysis({ analysis: validAnalysis });
    expect(result).toEqual({
      analysis: JSON.parse(validAnalysis),
      readable: JSON.stringify(JSON.parse(validAnalysis), null, 2),
    });
  });

  test("rejects malformed cached analysis", () => {
    const result = parseCachedLapAnalysis({ analysis: "not-json" });
    expect(result).toEqual({
      error: "Cached analysis is invalid JSON",
      readable: "Cached analysis is invalid and cannot be used safely.",
    });
  });

  test("rejects null, arrays, and schema-invalid cached rows", async () => {
    for (const analysis of [
      "null",
      "[]",
      JSON.stringify({ verdict: "missing required fields" }),
    ]) {
      const tool = getLapAnalysisToolFor(
        async () => ({
          analysis,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          durationMs: 1,
          model: "test-model",
        }),
        async () => ({ ...lap, carOrdinal: 0, trackOrdinal: null, tuneId: null, telemetry: [] }) as never,
        async () => null,
        (() => ({})) as never,
      );
      const execute = tool.execute;
      if (!execute) throw new Error("Lap analysis tool has no execute function");
      const rawResult = await execute({ lapId: 4 }, {} as never);
      if (!isLapResult(rawResult)) throw new Error("Unexpected lap analysis tool result");
      const result = rawResult;
      expect(result.available).toBe(false);
      expect(result.analysis).toBeUndefined();
      expect(result.error).toContain("schema");
    }
  });
  test("sanitizes cached setup against lap-linked snapshot and capabilities", async () => {
    const toolLap = {
      id: 4,
      gameId: "ac-evo" as const,
      carOrdinal: 1,
      trackOrdinal: 2,
      tuneId: 5,
      telemetry: [],
    };
    const tune = {
      id: 5,
      gameId: "ac-evo",
      carOrdinal: 1,
      trackOrdinal: 2,
      settings: { frontRideHeight: 56 },
    };
    const resolveGame = (() => ({
      getCarName: () => "Audi R8 LMS GT3 Evo II",
    })) as never;
    const context = setupContextForLap(toolLap, resolveGame, tune);
    const analysis = {
      ...JSON.parse(validAnalysis),
      setup: [
        {
          component: "Front Ride Height",
          symptom: "grounding",
          fix: "increase ride height",
          current: "999 mm",
          target: "57 mm",
          direction: "increase",
        },
        {
          component: "Front Ride Height",
          symptom: "grounding",
          fix: "increase ride height",
          current: "999 mm",
          target: "58",
          direction: "increase",
        },
        {
          component: "Differential Power",
          symptom: "traction",
          fix: "change power",
          current: "999",
          target: "1",
          direction: "increase",
        },
      ],
      setupProvenance: {
        gameId: context.gameId ?? null,
        gameVersion: null,
        carModel: context.carModel ?? null,
        carVersion: null,
        trackName: context.trackName ?? null,
        setupVersion: context.setupVersion == null ? null : String(context.setupVersion),
        lapId: context.lapId ?? null,
      },
    };
    const tool = getLapAnalysisToolFor(
      async () => ({
        analysis: JSON.stringify(analysis),
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        durationMs: 1,
        model: "test-model",
      }),
      async () => toolLap as never,
      async () => tune as never,
      resolveGame,
    );
    const execute = tool.execute;
    if (!execute) throw new Error("Lap analysis tool has no execute function");
    const rawResult = await execute({ lapId: 4 }, {} as never);
    if (!isLapResult(rawResult)) throw new Error("Unexpected lap analysis tool result");
    expect(rawResult.available).toBe(true);
    const output = rawResult.analysis;
    if (!output || typeof output !== "object" || !("setup" in output)) {
      throw new Error("Sanitized analysis setup missing");
    }
    expect(output.setup).toEqual([
      expect.objectContaining({
        component: "Front Ride Height",
        current: "56 mm",
        target: "57 mm",
      }),
    ]);
  });
  test("does not embed cached analysis in compare prompts", () => {
    const comparePrompt = buildCompareChatSystemPrompt(
      lap,
      { ...lap, lapNumber: 5 },
      comparison,
      "metric",
      "C",
      "en",
    );
    expect(comparePrompt).not.toContain("LAP A ANALYSIS");
    expect(comparePrompt).not.toContain("LAP B ANALYSIS");
    expect(comparePrompt).toContain("get_lap_analysis");
  });
});
