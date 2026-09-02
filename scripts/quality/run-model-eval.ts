#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Agent } from "@mastra/core/agent";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { initDb } from "../../server/db";
import { getMastraModelId } from "../../mastra/model";
import { analystScorers, compareScorers, scoreOutput } from "../../mastra/evals";
import { llmFaithfulnessScorer } from "../../mastra/evals/scorers/llm-faithfulness";
import { buildEvalCompareEngineerAgent, buildEvalLapAnalystAgent } from "../../mastra/evals/eval-agents";
import {
  buildModelComparisonReport,
  renderModelComparisonMarkdown,
  type ModelEvalDataset,
  type ModelEvalFailure,
  type ModelEvalObservation,
  type ModelEvalUsage,
} from "../../mastra/evals/model-comparison";
import { MODEL_EVAL_FIXTURES, buildModelEvalCases, loadParsedModelEvalFixture } from "./model-eval-cases";

const REPEAT_COUNT = 3;
const defaultModels = ["prism-ml/bonsai-27b", "qwen/qwen3.5-9b"];
const judgeEnabled = process.env.EVAL_LOCAL_JUDGE === "1";
const judgeModel = process.env.EVAL_JUDGE_MODEL ?? "google/gemma-4-e2b";
const separator = process.argv.indexOf("--");
const positional = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const requested = positional.filter((value) => value.trim()).map((value) => value.trim());
const modelIds = [...new Set(requested.length ? requested : defaultModels)];
const fixtureId = process.env.EVAL_FIXTURE_ID ?? "acc-brands-hatch-2026-04-10";
const fixture = MODEL_EVAL_FIXTURES[fixtureId];
if (!fixture) {
  console.error(`Model eval setup failed: unknown fixture "${fixtureId}" (available: ${Object.keys(MODEL_EVAL_FIXTURES).join(", ")})`);
  throw new Error(`Model eval setup failed: unknown fixture "${fixtureId}" (available: ${Object.keys(MODEL_EVAL_FIXTURES).join(", ")})`);
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
  throw new Error(`Model eval preflight failed: cannot read ${process.env.EVAL_LOCAL_ENDPOINT ?? "http://localhost:1234/v1"}/models`);
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
  throw new Error(`Model eval preflight failed: cannot read ${modelsUrl}`);
}
const missing = [...modelIds, ...(judgeEnabled ? [judgeModel] : [])].filter((id) => !available.includes(id));
if (missing.length) {
  console.error(`Model eval preflight failed: unavailable model(s): ${[...new Set(missing)].join(", ")}`);
  throw new Error(`Model eval preflight failed: unavailable model(s): ${[...new Set(missing)].join(", ")}`);
}

let parsedFixture: Awaited<ReturnType<typeof loadParsedModelEvalFixture>>;
let cases: Awaited<ReturnType<typeof buildModelEvalCases>>;
try {
  await initDb();
  initGameAdapters();
  initServerGameAdapters();
  parsedFixture = await loadParsedModelEvalFixture(fixture);
  cases = await buildModelEvalCases(parsedFixture);
} catch (error) {
  console.error(`Model eval setup failed: ${error instanceof Error ? error.message : String(error)}`);
  throw new Error(`Model eval setup failed: ${error instanceof Error ? error.message : String(error)}`);
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
      let usage: ModelEvalUsage | undefined;
      try {
        const response = await agent.generate(testCase.input);
        generationLatencyMs = performance.now() - started;
        output = response.text ?? "";
        const rawUsage = response.usage as Partial<ModelEvalUsage> | undefined;
        if (rawUsage) usage = Object.fromEntries(Object.entries(rawUsage).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as ModelEvalUsage;
        const scores = await Promise.all(scorers.map((scorer) => scoreOutput(scorer, output, testCase.groundTruth)));
        observations.push({ modelId: model, caseId: testCase.id, agent: testCase.agent, repeat, latencyMs: generationLatencyMs, output, scores, ...(usage ? { usage } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stage = output ? "scoring" : "generation";
        failures.push({ modelId: model, caseId: testCase.id, repeat, stage, message, ...(generationLatencyMs !== undefined ? { latencyMs: generationLatencyMs } : { latencyMs: performance.now() - started }), ...(output ? { output } : {}), ...(usage ? { usage } : {}) });
      }
    }
  }
}

if (judgeEnabled) {
  for (const model of modelIds) {
    const result = Bun.spawnSync(["lms", "unload", model], { stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) console.warn(`Model eval judge setup warning: could not unload ${model}`);
  }
  const judgeLoad = Bun.spawnSync(["lms", "load", judgeModel, "--context-length", "131072", "--parallel", "4", "--yes"], { stdout: "ignore", stderr: "pipe" });
  if (judgeLoad.exitCode !== 0) throw new Error(`Model eval judge setup failed: could not load ${judgeModel}`);
  for (const observation of observations) {
    const testCase = cases.find((item) => item.id === observation.caseId);
    if (!testCase) continue;
    try {
      const result = await scoreOutput(llmFaithfulnessScorer, observation.output, testCase.groundTruth);
      observation.scores.push({ ...result, id: "correctness" });
    } catch (error) {
      failures.push({ modelId: observation.modelId, caseId: observation.caseId, repeat: observation.repeat, stage: "scoring", message: error instanceof Error ? error.message : String(error), latencyMs: observation.latencyMs, output: observation.output, usage: observation.usage });
    }
  }
}

const createdAt = new Date().toISOString();
const dataset: ModelEvalDataset = { id: fixture.id, label: fixture.label, fixturePath: fixture.fixturePath, gameId: fixture.gameId, units: fixture.units, temperatureUnit: fixture.temperatureUnit, analystLap: fixture.analystLapNumber, compareLaps: fixture.compareLapNumbers };
const truth = Object.fromEntries(cases.map((item) => [item.id, item.groundTruth.truth]));
const report = buildModelComparisonReport({ createdAt, endpoint: baseURL, repeatCount: REPEAT_COUNT, ...(judgeEnabled ? { judgeModel } : {}), modelIds, dataset, caseIds: cases.map((item) => item.id), truth, observations, failures });
const markdown = renderModelComparisonMarkdown(report);
const modelStem = modelIds.map((model) => model.replace(/[^A-Za-z0-9._-]+/g, "-")).join("__");
const stem = `${modelStem}__${createdAt.replaceAll(":", "-").replaceAll(".", "-")}`;
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
