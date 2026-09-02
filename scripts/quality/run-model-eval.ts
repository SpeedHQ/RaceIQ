#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { initDb, db } from "../../server/db";
import { sessions, laps } from "../../server/db/schema";
import { RESOLVED_AI_MODEL_CONTEXT_KEY } from "../../server/ai/resolved-ai-internals";
import { getModel } from "../../server/ai/model-provider";
import { MODEL_EVAL_FIXTURES, loadParsedModelEvalFixture, buildModelEvalDatasetDefinitions, syncModelEvalDataset } from "../../mastra/evals/model-eval-datasets";
import { modelEvalModelIds } from "../../mastra/evals/model-eval-config";
import { RequestContext } from "@mastra/core/request-context";
const REPEAT_COUNT = 3;
const baseURL = (process.env.EVAL_LOCAL_ENDPOINT ?? "http://localhost:1234/v1").replace(/\/+$/, "");
const judgeEnabled = process.env.EVAL_LOCAL_JUDGE === "1";
const judgeModel = process.env.EVAL_JUDGE_MODEL ?? "google/gemma-4-e2b";
const args = process.argv.slice(2);
let compareToExperimentSetId: string | undefined;
const models: string[] = [];
for (const arg of args) {
  if (arg.startsWith("--compare-set=")) {
    const value = arg.slice("--compare-set=".length).trim();
    if (!value) throw new Error("--compare-set requires non-empty experimentSetId");
    compareToExperimentSetId = value;
  } else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
  else if (arg.trim()) models.push(arg.trim());
}
const modelIds = modelEvalModelIds(models, judgeEnabled, judgeModel);
const experimentSetId = new Date().toISOString().replace(/[:.]/g, "-");
const fixtureId = process.env.EVAL_FIXTURE_ID ?? "acc-brands-hatch-2026-04-10";
const fixture = MODEL_EVAL_FIXTURES[fixtureId];
if (!fixture) throw new Error(`Model eval setup failed: unknown fixture "${fixtureId}"`);
function canonical(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown): unknown => {
    if (v === undefined || typeof v === "function" || typeof v === "symbol") throw new Error("prompt contains unsupported value");
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("prompt contains non-finite number");
    if (v && typeof v === "object") { if (seen.has(v)) throw new Error("prompt contains cycle"); seen.add(v); const out = Array.isArray(v) ? v.map(encode) : Object.fromEntries(Object.keys(v).sort().map(k => [k, encode((v as Record<string, unknown>)[k])])); seen.delete(v); return out; }
    return v;
  };
  return JSON.stringify(encode(value));
}
const response = await fetch(`${baseURL}/models`);
if (!response.ok) throw new Error(`Model eval preflight failed: HTTP ${response.status}`);
const body: unknown = await response.json();
if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) throw new Error("Model eval preflight failed: invalid /models response shape");
const available = body.data.map(item => {
  if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string" || item.id.length === 0) throw new Error("Model eval preflight failed: invalid /models response shape");
  return item.id;
});
const missing = [...modelIds, ...(judgeEnabled ? [judgeModel] : [])].filter(id => !available.includes(id));
if (missing.length) throw new Error(`Model eval preflight failed: unavailable model(s): ${[...new Set(missing)].join(", ")}`);
await initDb(); initGameAdapters(); initServerGameAdapters();
const parsed = await loadParsedModelEvalFixture(fixture);
const fixtureLaps = [parsed.analystLap, ...parsed.compareLaps];
await db.insert(sessions).values({ carOrdinal: parsed.carOrdinal, trackOrdinal: parsed.trackOrdinal, gameId: parsed.config.gameId, ownership: "mine" }).onConflictDoNothing().run();
for (const lap of fixtureLaps) {
  if (typeof lap.id !== "number" || lap.id <= 0) throw new Error(`Model eval fixture ${fixture.id} missing persisted lap ID`);
  await db.insert(laps).values({ id: lap.id, sessionId: 1, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, rawByteOffset: lap.rawByteOffset, rawFrameCount: lap.rawFrameCount, profileId: lap.profileId, tuneId: lap.tuneId, invalidReason: lap.invalidReason, sectorTimes: lap.sectors }).onConflictDoNothing().run();
}
const definitions = await buildModelEvalDatasetDefinitions(parsed, REPEAT_COUNT);
const { mastra } = await import("../../mastra/index");
const synced = await Promise.all(definitions.map(definition => syncModelEvalDataset(mastra, definition)));
const sourceVersionResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
const sourceVersion = sourceVersionResult.exitCode === 0 ? new TextDecoder().decode(sourceVersionResult.stdout).trim() : "";
if (!sourceVersion) throw new Error("Model eval setup failed: unable to resolve sourceVersion");
const experiments: { id: string; modelId: string; agent: string; status: string; promptFingerprint: string }[] = [];
for (const modelId of modelIds) for (let index = 0; index < synced.length; index++) {
  const definition = definitions[index]; const { dataset, version } = synced[index];
  const requestContext = new RequestContext(); const modelConfig = { provider: "local", model: modelId, localEndpoint: baseURL }; requestContext.set(RESOLVED_AI_MODEL_CONTEXT_KEY, modelConfig); const experimentRequestContext = { [RESOLVED_AI_MODEL_CONTEXT_KEY]: modelConfig };
  const agent = mastra.getAgent(definition.targetId);
  const originalModel = (agent as unknown as { model: unknown }).model;
  (agent as unknown as { model: unknown }).model = getModel("analysis", requestContext);
  try {
    const instructions = await agent.getInstructions({ requestContext: requestContext as never });
    const promptFingerprint = createHash("sha256").update(canonical({ instructions, items: definition.items.map(({ externalId, input }) => ({ externalId, input })) })).digest("hex");
    const summary = await dataset.startExperiment({ targetType: "agent", targetId: definition.targetId, scorers: [...definition.scorerIds], requestContext: experimentRequestContext, metadata: { modelId, agent: definition.targetId, fixtureIds: [fixtureId], repeatCount: REPEAT_COUNT, endpoint: baseURL, judgeModel, sourceVersion, promptFingerprint, datasetVersion: version }, provenance: { source: "local", sourceId: "raceiq-oss-model-eval", sourceVersion, metadata: { promptFingerprint } }, grouping: { experimentSetId, comparisonId: definition.id, variantId: `${modelId}@${promptFingerprint.slice(0, 12)}` }, maxConcurrency: 1, maxRetries: 0, itemTimeout: 300_000, onEvent: (event: unknown) => console.log(JSON.stringify({ model: modelId, agent: definition.targetId, event })) });
    experiments.push({ id: summary.experimentId, modelId, agent: definition.targetId, status: summary.status, promptFingerprint });
    console.log(`Experiment ${summary.experimentId}: ${modelId} ${definition.targetId} ${summary.status}`);
  } finally {
    (agent as unknown as { model: unknown }).model = originalModel;
  }
}
if (judgeEnabled) {
  for (const model of modelIds) Bun.spawnSync(["lms", "unload", model], { stdout: "ignore", stderr: "ignore" });
  if (Bun.spawnSync(["lms", "load", judgeModel, "--context-length", "131072", "--parallel", "4", "--yes"], { stdout: "ignore", stderr: "pipe" }).exitCode !== 0) throw new Error(`Model eval judge setup failed: could not load ${judgeModel}`);
  const correctness = await mastra.datasets.create({ id: `raceiq-model-eval-correctness-${experimentSetId}`, name: `RaceIQ correctness ${experimentSetId}`, targetType: "workflow", targetIds: [], scorerIds: ["telemetry-correctness"] });
  for (const experiment of experiments) { const target = definitions.findIndex(definition => definition.targetId === experiment.agent); const results = await synced[target].dataset.listExperimentResults({ experimentId: experiment.id, page: 0, perPage: 1000 }); for (const result of results.results ?? []) if (result.output != null) await correctness.addItem({ input: { answer: result.output }, groundTruth: result.groundTruth, metadata: { candidateExperimentId: experiment.id, candidateResultId: String(result.id), candidateItemId: result.itemId, modelId: experiment.modelId, agent: experiment.agent, caseId: result.metadata?.caseId, repeat: result.metadata?.repeat } }); }
  const correctnessSummary = await correctness.startExperiment({ task: ({ input }) => (input as { answer: unknown }).answer, scorers: ["telemetry-correctness"], metadata: { experimentSetId, phase: "correctness", judgeModel }, grouping: { experimentSetId, comparisonId: correctness.id, variantId: `correctness@${experimentSetId}` }, maxConcurrency: 1, maxRetries: 0, itemTimeout: 300_000 });
  console.log(`Correctness experiment ${correctnessSummary.experimentId}: ${correctnessSummary.status}`);
} else console.log("No recommendation: correctness judge disabled");
const mod = await import("../../mastra/evals/model-eval-recommendation");
const report = await mod.buildModelRecommendation(mastra, experimentSetId, compareToExperimentSetId);
const outDir = resolve(process.cwd(), "test/artifacts/model-evals"); await mkdir(outDir, { recursive: true });
const stem = `${modelIds.map(m => m.replace(/[^A-Za-z0-9._-]+/g, "-")).join("__")}__${experimentSetId}`;
await Bun.write(`${outDir}/${stem}.json`, JSON.stringify(report, null, 2));
await Bun.write(`${outDir}/${stem}.md`, mod.renderModelRecommendationMarkdown(report));
console.log(`JSON: test/artifacts/model-evals/${stem}.json`); console.log(`Markdown: test/artifacts/model-evals/${stem}.md`);
const summaries = report.summaries;
if (experiments.some(e => e.status !== "completed") || !judgeEnabled || !summaries.some(summary => summary.eligible)) process.exitCode = 1;
