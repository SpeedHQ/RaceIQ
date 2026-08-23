#!/usr/bin/env bun
/**
 * Capture a baseline snapshot of AI quality scores for the current git SHA.
 *
 * Runs every analyst + compare fixture through the eval agent, scores each,
 * and writes the aggregate to `test/ai-fixtures/baselines/<sha>-<model>.json`.
 * Commit the baseline when you deliberately accept a prompt/model change as
 * the new normal — the regression test then measures relative drift against
 * the most recent committed baseline.
 *
 *   bun run ai:baseline
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { buildAnalystPrompt } from "../../server/ai/analyst-prompt";
import { compareLapHeader } from "../../server/ai/compare-engineer";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../shared/racing/analysis/laps/semantic-frame";
import { LiveTelemetryProjector } from "../../server/telemetry/live-projector";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { buildEvalLapAnalystAgent, buildEvalCompareEngineerAgent, resolveEvalModelId } from "../../mastra/evals/eval-agents";
import { listLapFixtures, listComparePairFixtures, loadLapPackets, type LapFixture, type ComparePairFixture } from "../../mastra/evals/fixtures";
import { analystScorers, compareScorers, scoreOutput } from "../../mastra/evals";

if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error("Missing GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY");
  process.exit(1);
}

initGameAdapters();
initServerGameAdapters();

const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim() || "nosha";
const model = resolveEvalModelId().replace("/", "-");
const outDir = resolve(import.meta.dir, "../../test/ai-fixtures/baselines");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/${sha}-${model}.json`;

interface BaselineRow {
  fixtureId: string;
  agent: "lap-analyst" | "compare-engineer";
  scores: Record<string, number>;
  reasons: Record<string, string>;
}

const rows: BaselineRow[] = [];

for (const fx of listLapFixtures()) {
  const packets = loadLapPackets(fx.__file, fx.packetsPath, fx.packetsEntry);
  if (!packets || packets.length === 0) {
    console.warn(`[skip] ${fx.id} — no packets zip`);
    continue;
  }
  console.log(`[run]  ${fx.id} (analyst)`);
  const samples = semanticSamplesFromPackets(packets);
  const prompt = buildAnalystPrompt({ ...fx.lap, gameId: fx.game }, samples, deriveCornerDefs(fx), fx.units);
  const agent = buildEvalLapAnalystAgent();
  const response = await agent.generate(prompt);
  const output = response.text ?? "";
  const gt = {
    slowestCorners: fx.expected.slowestCorners,
    trackCorners: fx.expected.trackCorners,
    units: fx.units,
  };
  const results = await Promise.all(analystScorers.map((s) => scoreOutput(s, output, gt)));
  rows.push({
    fixtureId: fx.id,
    agent: "lap-analyst",
    scores: Object.fromEntries(results.map((r) => [r.id, r.score])),
    reasons: Object.fromEntries(results.map((r) => [r.id, r.reason])),
  });
}

for (const fx of listComparePairFixtures()) {
  const packetsA = loadLapPackets(fx.__file, fx.lapA.packetsPath, fx.lapA.packetsEntry);
  const packetsB = loadLapPackets(fx.__file, fx.lapB.packetsPath, fx.lapB.packetsEntry);
  if (!packetsA || !packetsB || !packetsA.length || !packetsB.length) {
    console.warn(`[skip] ${fx.id} — missing packets`);
    continue;
  }
  const samplesA = semanticSamplesFromPackets(packetsA);
  const samplesB = semanticSamplesFromPackets(packetsB);
  console.log(`[run]  ${fx.id} (compare)`);
  const prompt = buildComparePrompt(fx, samplesA, samplesB);
  const agent = buildEvalCompareEngineerAgent(fx.units);
  const response = await agent.generate(prompt);
  const output = response.text ?? "";
  const gt = {
    fasterLap: fx.expected.fasterLap,
    trackCorners: fx.expected.trackCorners,
    units: fx.units,
  };
  const results = await Promise.all(compareScorers.map((s) => scoreOutput(s, output, gt)));
  rows.push({
    fixtureId: fx.id,
    agent: "compare-engineer",
    scores: Object.fromEntries(results.map((r) => [r.id, r.score])),
    reasons: Object.fromEntries(results.map((r) => [r.id, r.reason])),
  });
}

const aggregate: Record<string, { sum: number; count: number }> = {};
for (const row of rows) {
  for (const [id, score] of Object.entries(row.scores)) {
    let agg = aggregate[id];
    if (!agg) {
      agg = { sum: 0, count: 0 };
      aggregate[id] = agg;
    }
    agg.sum += score;
    agg.count += 1;
  }
}
const average = Object.fromEntries(Object.entries(aggregate).map(([k, v]) => [k, v.sum / v.count]));

writeFileSync(
  outPath,
  JSON.stringify(
    {
      sha,
      model: resolveEvalModelId(),
      capturedAt: new Date().toISOString(),
      average,
      rows,
    },
    null,
    2,
  ),
);

console.log(`\nWrote ${outPath}`);
console.log("Averages:", average);

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

function buildComparePrompt(fx: ComparePairFixture, samplesA: readonly SemanticTelemetrySample[], samplesB: readonly SemanticTelemetrySample[]) {
  const trackName = resolveTrackName(fx.lapA.trackOrdinal);
  const carA = resolveCarName(fx.lapA.carOrdinal);
  const carB = resolveCarName(fx.lapB.carOrdinal);
  const finalDelta = fx.lapA.lapTime - fx.lapB.lapTime;
  const header = compareLapHeader(trackName, carA, carB, fx.lapA, fx.lapB, finalDelta);
  const summarise = (samples: readonly SemanticTelemetrySample[], label: string) => {
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
${summarise(samplesA, "Lap A")}
${summarise(samplesB, "Lap B")}

Which lap is faster, and where is time being gained? Coach the slower lap.`;
}
