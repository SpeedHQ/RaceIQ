#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getMastraModelId } from "../../mastra/model";
import { buildEvalCompareEngineerAgent, buildEvalLapAnalystAgent } from "../../mastra/evals/eval-agents";
import { analystScorers, compareScorers, scoreOutput } from "../../mastra/evals";
import {
  buildModelComparisonReport,
  renderModelComparisonMarkdown,
  type ModelEvalDataset,
  type ModelEvalFailure,
  type ModelEvalObservation,
} from "../../mastra/evals/model-comparison";
import { MODEL_EVAL_FIXTURES, buildModelEvalCases, loadParsedModelEvalFixture } from "./model-eval-cases";

const REPEAT_COUNT = 3;
const defaultModels = ["prism-ml/bonsai-27b", "qwen/qwen3.5-9b"];
const separator = process.argv.indexOf("--");
const positional = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const requested = positional.filter((value) => value.trim()).map((value) => value.trim());
const modelIds = [...new Set(requested.length ? requested : defaultModels)];
const fixtureId = process.env.EVAL_FIXTURE_ID ?? "acc-brands-hatch-2026-04-10";
const fixture = MODEL_EVAL_FIXTURES[fixtureId];
if (!fixture) {
  console.error(`Model eval setup failed: unknown fixture "${fixtureId}" (available: ${Object.keys(MODEL_EVAL_FIXTURES).join(", ")})`);
  process.exit(1);
}

function endpoint(): string {
  const value = process.env.EVAL_LOCAL_ENDPOINT ?? "http://localhost:1234/v1";
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("endpoint must be HTTP(S)"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("endpoint must be HTTP(S)");
  return value.replace(/\/+$/, "");
}

let baseURL: string;
try { baseURL = endpoint(); } catch (error) {
  console.error(`Model eval preflight failed: cannot read ${process.env.EVAL_LOCAL_ENDPOINT ?? "http://localhost:1234/v1"}/models: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const modelsUrl = `${baseURL}/models`;
let available: string[];
try {
  const response = await fetch(modelsUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data) || !(body as { data: unknown[] }).data.every((item) => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string")) throw new Error("invalid /models response shape");
  available = (body as { data: { id: string }[] }).data.map((item) => item.id);
} catch (error) {
  console.error(`Model eval preflight failed: cannot read ${modelsUrl}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const missing = modelIds.filter((id) => !available.includes(id));
if (missing.length) {
  console.error(`Model eval preflight failed: unavailable model(s): ${missing.join(", ")}`);
  process.exit(1);
}

let parsedFixture: Awaited<ReturnType<typeof loadParsedModelEvalFixture>>;
let cases: Awaited<ReturnType<typeof buildModelEvalCases>>;
try {
  initGameAdapters();
  initServerGameAdapters();
  parsedFixture = await loadParsedModelEvalFixture(fixture);
  cases = await buildModelEvalCases(parsedFixture);
} catch (error) {
  console.error(`Model eval setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const observations: ModelEvalObservation[] = [];
const failures: ModelEvalFailure[] = [];
for (const model of modelIds) {
  const bound = getMastraModelId({ provider: "local", model, localEndpoint: baseURL });
  const analyst = buildEvalLapAnalystAgent(bound);
  const compareAgents: Record<string, Agent> = {};
  for (const testCase of cases) {
    const agent = testCase.agent === "lap-analyst" ? analyst : (compareAgents[parsedFixture.config.units] ?? (compareAgents[parsedFixture.config.units] = buildEvalCompareEngineerAgent(parsedFixture.config.units, bound)));
    const scorers = testCase.agent === "lap-analyst" ? analystScorers : compareScorers;
    for (let repeat = 1; repeat <= REPEAT_COUNT; repeat++) {
      const started = performance.now();
      let output = "";
      let generationLatencyMs: number | undefined;
      try {
        const response = await agent.generate(testCase.input);
        generationLatencyMs = performance.now() - started;
        output = response.text ?? "";
        if (!output) throw new Error("empty model response");
        const scores = await Promise.all(scorers.map((scorer) => scoreOutput(scorer, output, testCase.groundTruth)));
        observations.push({ modelId: model, caseId: testCase.id, agent: testCase.agent, repeat, latencyMs: generationLatencyMs, output, scores });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stage = output ? "scoring" : "generation";
        failures.push({ modelId: model, caseId: testCase.id, repeat, stage, message, ...(generationLatencyMs !== undefined ? { latencyMs: generationLatencyMs } : { latencyMs: performance.now() - started }), ...(output ? { output } : {}) });
      }
    }
  }
}

const createdAt = new Date().toISOString();
const dataset: ModelEvalDataset = { id: fixture.id, label: fixture.label, fixturePath: fixture.fixturePath, gameId: fixture.gameId, units: fixture.units, temperatureUnit: fixture.temperatureUnit, analystLap: fixture.analystLapNumber, compareLaps: fixture.compareLapNumbers };
const report = buildModelComparisonReport({ createdAt, endpoint: baseURL, repeatCount: REPEAT_COUNT, modelIds, dataset, caseIds: cases.map((item) => item.id), observations, failures });
const markdown = renderModelComparisonMarkdown(report);
const stem = createdAt.replaceAll(":", "-").replaceAll(".", "-");
const outDir = resolve(process.cwd(), "test/artifacts/model-evals");
await mkdir(outDir, { recursive: true });
const jsonPath = `${outDir}/${stem}.json`;
const markdownPath = `${outDir}/${stem}.md`;
await Bun.write(jsonPath, JSON.stringify(report, null, 2));
await Bun.write(markdownPath, markdown);
console.log(markdown);
console.log(`JSON: test/artifacts/model-evals/${stem}.json`);
console.log(`Markdown: test/artifacts/model-evals/${stem}.md`);
if (report.summaries.some((summary) => !summary.complete)) process.exitCode = 1;
