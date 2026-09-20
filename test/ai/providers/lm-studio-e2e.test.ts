import { expect, test } from "bun:test";

import { getOpenAiCompatibleModelsDetailed, runOpenAiCompatible } from "../../../server/ai/providers";

const runLocalLmStudio = process.env.LM_STUDIO_E2E === "1" && !process.env.CI;
const endpoint = process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1";
const apiKey = process.env.LM_STUDIO_API_KEY || undefined;
const nativeBase = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");

test.skipIf(!runLocalLmStudio)("LM Studio loads a Qwen model and completes an OpenAI-compatible request", async () => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const catalogResponse = await fetch(`${nativeBase}/api/v1/models`, { headers });
  expect(catalogResponse.ok).toBe(true);
  const catalog = await catalogResponse.json() as {
    models?: Array<{ key?: string; id?: string; type?: string }>;
  };
  const models = catalog.models ?? [];
  const requestedModel = process.env.LM_STUDIO_MODEL;
  const qwen = models.find((model) => (model.key || model.id || "").toLowerCase().includes("qwen"));
  const model = requestedModel || qwen?.key || qwen?.id;
  if (!model) throw new Error("LM Studio model catalog must contain Qwen; set LM_STUDIO_MODEL to override");

  const loadResponse = await fetch(`${nativeBase}/api/v1/models/load`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model }),
  });
  const loadBody = await loadResponse.text();
  expect(loadResponse.ok, `LM Studio failed loading ${model}: ${loadBody}`).toBe(true);

  const modelResult = await getOpenAiCompatibleModelsDetailed(endpoint, apiKey);
  expect(modelResult.error).toBeNull();
  expect(modelResult.models.some((candidate) => candidate.id === model)).toBe(true);

  const result = await runOpenAiCompatible({
    endpoint,
    apiKey,
    model,
    prompt: "Reply with exactly: LM Studio OK",
    temperature: 0,
    maxOutputTokens: 32,
  });

  expect(result.usage.model).toBe(model);
  expect(result.analysis.trim()).toContain("LM Studio OK");
}, 120_000);
