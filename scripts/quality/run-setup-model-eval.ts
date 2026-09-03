#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { initDb } from "../../server/db";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";

// Wrapper installs DATA_DIR and Mastra persistence variables before this module loads.
await initDb();
initGameAdapters();
initServerGameAdapters();

const { RequestContext } = await import("@mastra/core/request-context");
const { RESOLVED_AI_MODEL_CONTEXT_KEY } = await import("../../server/ai/resolved-ai-internals");
const { getModel } = await import("../../server/ai/model-provider");
const { mastra } = await import("../../mastra/index");
const { buildSetupEngineerModelEvalDefinition, setupEngineerModelEvalModelIds, syncSetupEngineerModelEvalDataset } = await import("../../mastra/evals/setup-engineer-model-eval");

const endpoint = (process.env.EVAL_LOCAL_ENDPOINT ?? "http://localhost:1234/v1").replace(/\/+$/, "");
const requested = process.argv.slice(2).filter((arg) => arg.trim());
const modelIds = setupEngineerModelEvalModelIds(requested);
const experimentSetId = new Date().toISOString().replace(/[:.]/g, "-");
const definition = buildSetupEngineerModelEvalDefinition();
const { dataset, version } = await syncSetupEngineerModelEvalDataset(mastra, definition);
const sourceVersionResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
const sourceVersion = sourceVersionResult.exitCode === 0 ? new TextDecoder().decode(sourceVersionResult.stdout).trim() : "";
if (!sourceVersion) throw new Error("Setup model eval failed: unable to resolve sourceVersion");
for (const modelId of modelIds) {
  const requestContext = new RequestContext();
  const modelConfig = { provider: "local", model: modelId, localEndpoint: endpoint };
  requestContext.set(RESOLVED_AI_MODEL_CONTEXT_KEY, { ...modelConfig, gameId: "acc", sessionId: definition.items[0]?.metadata && typeof definition.items[0].metadata === "object" && definition.items[0].metadata !== null && "sessionId" in definition.items[0].metadata ? definition.items[0].metadata.sessionId : 9001 });
  const agent = mastra.getAgent("setup-engineer");
  const originalModel = (agent as unknown as { model: unknown }).model;
  (agent as unknown as { model: unknown }).model = getModel("analysis", requestContext);
  try {
    const instructions = await agent.getInstructions({ requestContext: requestContext as never });
    const promptFingerprint = createHash("sha256").update(JSON.stringify({ instructions, items: definition.items.map(({ externalId, input }) => ({ externalId, input })) })).digest("hex");
    const summary = await dataset.startExperiment({ targetType: "agent", targetId: "setup-engineer", scorers: [...definition.scorerIds], requestContext: { [RESOLVED_AI_MODEL_CONTEXT_KEY]: modelConfig, gameId: "acc", sessionId: 9001 }, metadata: { modelId, agent: "setup-engineer", fixtureIds: ["acc-setup-confirmation"], repeatCount: 1, endpoint, experimentSetId, datasetVersion: version, sourceVersion, promptFingerprint }, provenance: { source: "local", sourceId: "raceiq-oss-setup-model-eval", sourceVersion, metadata: { promptFingerprint } }, grouping: { experimentSetId, comparisonId: definition.id, variantId: `${modelId}@${promptFingerprint.slice(0, 12)}` }, maxConcurrency: 1, maxRetries: 0, itemTimeout: 300_000, onEvent: (event: unknown) => console.log(JSON.stringify({ model: modelId, agent: "setup-engineer", event })) });
    console.log(`Setup experiment ${summary.experimentId}: ${modelId} ${summary.status}`);
  } finally { (agent as unknown as { model: unknown }).model = originalModel; }
}
