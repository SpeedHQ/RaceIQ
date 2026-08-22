/**
 * AI quality regression gate.
 *
 * Runs each fixture through the relevant agent, then scores the output with
 * deterministic scorers. Fails the build if any scorer drops below the
 * threshold in `mastra/evals/index.ts::SCORER_THRESHOLDS`.
 *
 * Skipped entirely when:
 *   - No `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` — fresh clones
 *     and PRs from forks without secrets won't flake.
 *   - No fixture zip files present — scaffolding ships without packets so
 *     contributors can opt in by exporting their own laps.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { initGameAdapters } from "../../../shared/games/init";
import { initServerGameAdapters } from "../../../server/games/init";
import { buildAnalystPrompt } from "../../../server/ai/analyst-prompt";
import { compareLapHeader } from "../../../server/ai/compare-engineer";
import { resolveCarName } from "../../../shared/racing/cars/resolve-name";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../../shared/racing/analysis/laps/semantic-frame";
import { LiveTelemetryProjector } from "../../../server/telemetry/live-projector";
import { resolveTrackName } from "../../../shared/racing/tracks/resolve-name";
import { buildEvalLapAnalystAgent, buildEvalCompareEngineerAgent, resolveEvalModelId } from "../../../mastra/evals/eval-agents";
import { listLapFixtures, listComparePairFixtures, loadLapPackets, type LapFixture, type ComparePairFixture } from "../../../mastra/evals/fixtures";
import { analystScorers, compareScorers, judgeScorers, scoreOutput, SCORER_THRESHOLDS, type ScoreResult } from "../../../mastra/evals";

const HAS_API_KEY = Boolean(process.env.GEMINI_API_KEY) || Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

const describeIf = HAS_API_KEY ? describe : describe.skip;

/**
 * Model-graded (LLM-as-judge) scorers only run when a local LM Studio judge
 * is reachable. Opt in with EVAL_LOCAL_JUDGE=1 (LM Studio serving
 * google/gemma-4-e2b at http://localhost:1234/v1 — override via
 * EVAL_JUDGE_BASE_URL / EVAL_JUDGE_MODEL). The same `judgeScorers` array is
 * reused by the setup-engineer eval below — one faithfulness judge, both agents.
 */
const HAS_LOCAL_JUDGE = process.env.EVAL_LOCAL_JUDGE === "1";

beforeAll(() => {
  initGameAdapters();
  initServerGameAdapters();
});

describeIf("AI quality — Lap Analyst", () => {
  const fixtures = listLapFixtures();
  if (fixtures.length === 0) {
    test.skip("no fixtures registered in test/ai-fixtures/laps/", () => {});
    return;
  }

  for (const fx of fixtures) {
    const packets = loadLapPackets(fx.__file, fx.packetsPath, fx.packetsEntry);
    const hasPackets = packets !== null && packets.length > 0;
    const runOrSkip = hasPackets ? test : test.skip;

    runOrSkip(
      `${fx.id} (model=${resolveEvalModelId()})`,
      async () => {
        const samples = semanticSamplesFromPackets(packets!);
        const prompt = buildAnalystPrompt({ ...fx.lap, gameId: fx.game }, samples, deriveCornerDefs(fx), fx.units);
        const agent = buildEvalLapAnalystAgent();
        const response = await agent.generate(prompt);
        const output = response.text ?? "";

        const groundTruth = {
          slowestCorners: fx.expected.slowestCorners,
          trackCorners: fx.expected.trackCorners,
          units: fx.units,
          // Source the judge grades against: the exact prompt the agent saw.
          sourceContext: prompt,
        };

        const scorers = HAS_LOCAL_JUDGE ? [...analystScorers, ...judgeScorers] : analystScorers;
        const results = await Promise.all(scorers.map((s) => scoreOutput(s, output, groundTruth)));

        reportScores(fx.id, results);
        for (const r of results) {
          expect(r.score, `${fx.id} · ${r.id} — ${r.reason}`).toBeGreaterThanOrEqual(SCORER_THRESHOLDS[r.id] ?? 0.5);
        }
      },
      180_000,
    );
  }
});

describeIf("AI quality — Compare Engineer", () => {
  const fixtures = listComparePairFixtures();
  if (fixtures.length === 0) {
    test.skip("no fixtures registered in test/ai-fixtures/compare-pairs/", () => {});
    return;
  }

  for (const fx of fixtures) {
    const packetsA = loadLapPackets(fx.__file, fx.lapA.packetsPath, fx.lapA.packetsEntry);
    const packetsB = loadLapPackets(fx.__file, fx.lapB.packetsPath, fx.lapB.packetsEntry);
    const hasPackets = packetsA && packetsB && packetsA.length > 0 && packetsB.length > 0;
    const runOrSkip = hasPackets ? test : test.skip;

    runOrSkip(
      `${fx.id} (model=${resolveEvalModelId()})`,
      async () => {
        const samplesA = semanticSamplesFromPackets(packetsA!);
        const samplesB = semanticSamplesFromPackets(packetsB!);
        const prompt = buildMinimalComparePrompt(fx, samplesA, samplesB);
        const agent = buildEvalCompareEngineerAgent(fx.units);
        const response = await agent.generate(prompt);
        const output = response.text ?? "";

        const groundTruth = {
          fasterLap: fx.expected.fasterLap,
          trackCorners: fx.expected.trackCorners,
          units: fx.units,
        };

        const results = await Promise.all(compareScorers.map((s) => scoreOutput(s, output, groundTruth)));

        reportScores(fx.id, results);
        for (const r of results) {
          expect(r.score, `${fx.id} · ${r.id} — ${r.reason}`).toBeGreaterThanOrEqual(SCORER_THRESHOLDS[r.id] ?? 0.5);
        }
      },
      180_000,
    );
  }
});

/**
 * Derive minimal CornerDef[] for the analyst prompt from the fixture's
 * trackCorners list. Distances are synthetic (evenly spaced) — good enough
 * for labeling; the real distances come from the per-track corner index
 * which is out of scope for Phase 1 evals.
 */
function deriveCornerDefs(fx: LapFixture) {
  const corners = fx.expected.trackCorners;
  return corners.map((label, i) => ({
    index: i,
    label,
    distanceStart: (i / corners.length) * 1000,
    distanceEnd: ((i + 1) / corners.length) * 1000,
  }));
}

function semanticSamplesFromPackets(packets: readonly TelemetryPacket[]): SemanticTelemetrySample[] {
  const projector = new LiveTelemetryProjector(CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS);
  const samples: SemanticTelemetrySample[] = [];
  for (const packet of packets) {
    samples.push(
      projector.project({
        packet,
        receivedAtMs: packet.TimestampMS,
      }).sample,
    );
  }
  return samples;
}

function buildMinimalComparePrompt(fx: ComparePairFixture, samplesA: readonly SemanticTelemetrySample[], samplesB: readonly SemanticTelemetrySample[]): string {
  const trackName = resolveTrackName(fx.lapA.trackOrdinal);
  const carA = resolveCarName(fx.lapA.carOrdinal);
  const carB = resolveCarName(fx.lapB.carOrdinal);
  const finalDelta = fx.lapA.lapTime - fx.lapB.lapTime;
  const header = compareLapHeader(trackName, carA, carB, fx.lapA, fx.lapB, finalDelta);

  const inputSummary = (samples: readonly SemanticTelemetrySample[], label: string) => {
    let throttleTotal = 0;
    let brakeTotal = 0;
    let topSpeed = 0;
    for (const sample of samples) {
      const throttle = sample.values["inputs.accel"];
      const brake = sample.values["inputs.brake"];
      const speed = sample.values["motion.speed"];
      if (typeof throttle === "number") throttleTotal += throttle;
      if (typeof brake === "number") brakeTotal += brake;
      if (typeof speed === "number" && speed > topSpeed) topSpeed = speed;
    }
    return `${label}: avg throttle ${(throttleTotal / samples.length).toFixed(1)}, avg brake ${(brakeTotal / samples.length).toFixed(1)}, top speed ${topSpeed.toFixed(1)}`;
  };

  return `${header}

--- LAP SUMMARY ---
${inputSummary(samplesA, "Lap A")}
${inputSummary(samplesB, "Lap B")}

Which lap is faster, and where is time being gained? Coach the slower lap.`;
}

function reportScores(fixtureId: string, results: ScoreResult[]) {
  const row = results.map((r) => `${r.id}=${r.score.toFixed(2)}`).join("  ");
  console.log(`  [eval] ${fixtureId}  ${row}`);
}
