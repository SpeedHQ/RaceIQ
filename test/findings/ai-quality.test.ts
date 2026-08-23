import { describe, expect, test } from "bun:test";

import { buildAnalystPrompt } from "../../server/ai/analyst-prompt";
import { buildChatSystemPrompt } from "../../server/ai/chat-prompt";
import { buildCompareInsightsBlock } from "../../server/ai/insight-format";
import { initServerGameAdapters } from "../../server/games/init";
import { initGameAdapters } from "../../shared/games/init";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

initGameAdapters();
initServerGameAdapters();

function sample(index: number, count: number): SemanticTelemetrySample {
  const progress = count <= 1 ? 0 : index / (count - 1);
  return {
    sequence: String(index),
    observedAtMs: progress * 90_000,
    values: {
      "motion.velocity-x": 20,
      "motion.velocity-y": 0,
      "motion.velocity-z": 0,
      "engine.current-engine-rpm": 6000,
      "inputs.accel": 128,
      "inputs.brake": 0,
      "inputs.gear": 3,
      "tire.temperature.average": [80, 80, 80, 80],
      "tires.tire-wear": [0.1, 0.1, 0.1, 0.1],
      "suspension.suspension-travel-m": [0.1, 0.1, 0.1, 0.1],
      "timing.distance-traveled": progress * 1000,
      "timing.current-lap": progress * 90,
      "motion.position-x": 0,
      "motion.position-z": 0,
    },
  };
}

const currentQuality = finalizeLapQualityGeneration(summarize(qualityPackets(200)), `sha256:${"a".repeat(64)}`, {
  lapNumber: 2,
  rawByteOffset: null,
  rawFrameCount: 200,
});

const lap = {
  id: 41,
  sessionId: 7,
  lapNumber: 2,
  lapTime: 90,
  isValid: true,
  gameId: "fm-2023" as const,
  quality: currentQuality.quality,
  eligibility: currentQuality.eligibility,
  qualityGeneration: currentQuality.quality.provenance.outputGeneration,
};

describe("AI lap quality context", () => {
  test("analyst, lap chat, and compare context abstain for rejected telemetry", () => {
    const rejectedPackets = [sample(0, 1)];

    const analystPrompt = buildAnalystPrompt(lap, rejectedPackets, []);
    const chatPrompt = buildChatSystemPrompt(lap, rejectedPackets, []);
    const compareContext = buildCompareInsightsBlock("Lap A", rejectedPackets, lap.gameId, {
      sessionId: lap.sessionId,
      lapId: lap.id,
      lapTime: lap.lapTime,
      quality: lap.quality,
    });

    for (const context of [analystPrompt, chatPrompt, compareContext]) {
      expect(context).toContain("[ABSTENTION]");
      expect(context).toContain("too few telemetry packets");
      expect(context).toContain("do not make lap-performance claims");
    }
  });

  test("valid telemetry keeps AI context available without quality abstention", () => {
    const validPackets = Array.from({ length: 30 }, (_, index) => sample(index, 30));

    expect(buildAnalystPrompt(lap, validPackets, [])).not.toContain("Lap recording quality rejected");
    expect(buildChatSystemPrompt(lap, validPackets, [])).not.toContain("Lap recording quality rejected");
    expect(
      buildCompareInsightsBlock("Lap A", validPackets, lap.gameId, {
        sessionId: lap.sessionId,
        lapId: lap.id,
        lapTime: lap.lapTime,
        quality: lap.quality,
      }),
    ).not.toContain("recording quality rejected");
  });

  test("analyst prompt uses only supplied persisted findings", () => {
    const validPackets = Array.from({ length: 30 }, (_, index) => sample(index, 30));
    const persistedFinding = {
      schemaVersion: "1",
      id: "persisted-current-finding",
      type: "recording-limited",
      category: "quality",
      scope: { kind: "lap", gameId: lap.gameId, sessionId: String(lap.sessionId), lapId: String(lap.id) },
      status: "indeterminate",
      severity: "informational",
      confidence: "unknown",
      measurements: [],
      evidenceRefs: [],
      qualityRefs: [],
      limitations: [{ code: "persisted-only", detail: "Current stored receipt controls this context." }],
      rule: { id: "stored-rule", version: "1", inputs: {} },
      analysisGenerationId: "stored-generation",
    } as never;

    const withoutStoredFindings = buildAnalystPrompt(lap, validPackets, []);
    const withStoredFindings = buildAnalystPrompt(lap, validPackets, [], "metric", "C", undefined, undefined, undefined, "en", undefined, [persistedFinding]);

    expect(withoutStoredFindings).not.toContain("persisted-current-finding");
    expect(withStoredFindings).toContain("[ABSTENTION] persisted-current-finding: indeterminate");
    expect(withStoredFindings).toContain("Current stored receipt controls this context.");
  });
});
