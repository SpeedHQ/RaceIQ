import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { getSeededLapTarget } from "../../support/seeded/laps";
import { getAlternateSeededLap, openAnalyseLap } from "./fixtures";

const runQwenE2E = process.env.LM_STUDIO_E2E === "1" && !process.env.CI;
const model = () => process.env.LM_STUDIO_MODEL || "qwen/qwen3.5-9b";
const endpoint = () => process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1";

async function configureQwen(request: APIRequestContext): Promise<Record<string, unknown>> {
  const originalResponse = await request.get("/api/settings");
  expect(originalResponse.ok()).toBe(true);
  const original = await originalResponse.json() as Record<string, unknown>;
  const response = await request.put("/api/settings", {
    data: { aiProvider: "openai-compatible", aiModel: model(), chatProvider: "openai-compatible", chatModel: model(), localEndpoint: endpoint() },
  });
  expect(response.ok()).toBe(true);
  return original;
}

async function sendThroughChatUi(page: Page, path: string): Promise<{ ok: boolean; status: number }> {
  const responsePromise = page.waitForResponse((response) => response.url().includes(path) && response.request().method() === "POST", { timeout: 120_000 });
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Message input" }).fill("Reply briefly: OK");
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await responsePromise;
  await expect(page.locator(".aui-composer-send")).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-slot="aui-message-error-message"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="aui_assistant-message-content"]').last()).not.toBeEmpty();
  return { ok: response.ok(), status: response.status() };
}

async function generateAnalysis(request: APIRequestContext, lapId: number): Promise<void> {
  const result = await request.post(`/api/laps/${lapId}/analyse?regenerate=true`, { timeout: 120_000 });
  expect(result.ok(), `Analyse request failed (${result.status()})`).toBe(true);
  const body = await result.text();
  const event = body.trim().split("\n").map((line) => JSON.parse(line)).findLast((item: { type?: string }) => item.type === "result") as { analysis?: string } | undefined;
  expect(event?.analysis, `Analyse returned no result for lap ${lapId}`).toBeTruthy();
}

test("Analyse calls Qwen through frontend and returns structured output", async ({ page, request }) => {
  test.skip(!runQwenE2E, "LM_STUDIO_E2E=1 and CI unset required");
  test.setTimeout(260_000);
  const original = await configureQwen(request);
  const lap = await getSeededLapTarget(request, "fm-2023");
  try {
    await request.delete(`/api/laps/${lap.id}/analyse`);
    await openAnalyseLap(page, lap);
    const response = await page.evaluate(async (id) => {
      const result = await fetch(`/api/laps/${id}/analyse?regenerate=true`, { method: "POST" });
      return { ok: result.ok, status: result.status, body: await result.text() };
    }, lap.id);
    expect(response.ok, `Analyse request failed (${response.status})`).toBe(true);
    const event = response.body.trim().split("\n").map((line) => JSON.parse(line)).findLast((item: { type?: string }) => item.type === "result") as { analysis?: string; cached?: boolean } | undefined;
    expect(event?.cached).toBe(false);
    expect(Object.keys(JSON.parse(event!.analysis!))).toEqual(["verdict", "pace", "handling", "corners", "technique", "setup"]);
  } finally {
    await request.delete(`/api/laps/${lap.id}/analyse`);
    await request.put("/api/settings", { data: original });
  }
});

test("Analyse lap chat calls Qwen through frontend", async ({ page, request }) => {
  test.skip(!runQwenE2E, "LM_STUDIO_E2E=1 and CI unset required");
  test.setTimeout(200_000);
  const original = await configureQwen(request);
  const lap = await getSeededLapTarget(request, "fm-2023");
  try {
    await generateAnalysis(request, lap.id);
    await page.goto(`/fm23/analyse?track=${lap.trackOrdinal}&car=${lap.carOrdinal}&lap=${lap.id}&ai=1`, { waitUntil: "domcontentloaded" });
    const response = await sendThroughChatUi(page, `/api/laps/${lap.id}/chat`);
    expect(response.ok, `Lap chat failed (${response.status})`).toBe(true);
  } finally {
    await request.delete(`/api/laps/${lap.id}/chat`);
    await request.put("/api/settings", { data: original });
  }
});

test("Compare chat calls Qwen through frontend", async ({ page, request }) => {
  test.skip(!runQwenE2E, "LM_STUDIO_E2E=1 and CI unset required");
  test.setTimeout(260_000);
  const original = await configureQwen(request);
  const lap = await getSeededLapTarget(request, "fm-2023");
  const alternate = await getAlternateSeededLap(request, lap);
  try {
    await request.delete(`/api/laps/${lap.id}/analyse`);
    await request.delete(`/api/laps/${alternate.id}/analyse`);
    await generateAnalysis(request, lap.id);
    await generateAnalysis(request, alternate.id);
    await page.goto(`/fm23/compare?track=${lap.trackOrdinal}&carA=${lap.carOrdinal}&carB=${alternate.carOrdinal}&lapA=${lap.id}&lapB=${alternate.id}&ai=1`, { waitUntil: "domcontentloaded" });
    const response = await sendThroughChatUi(page, `/api/laps/${lap.id}/compare/${alternate.id}/chat`);
    expect(response.ok, `Compare chat failed (${response.status})`).toBe(true);
  } finally {
    await request.delete(`/api/laps/${lap.id}/compare/${alternate.id}/chat`);
    await request.delete(`/api/laps/${lap.id}/analyse`);
    await request.delete(`/api/laps/${alternate.id}/analyse`);
    await request.put("/api/settings", { data: original });
  }
});

test("Experiment setup chat calls Qwen through frontend", async ({ page, request }) => {
  test.skip(!runQwenE2E, "LM_STUDIO_E2E=1 and CI unset required");
  test.setTimeout(200_000);
  const original = await configureQwen(request);
  let experimentId: number | undefined;
  try {
    const experimentsResponse = await request.get("/api/experiments?gameId=f1-2025");
    expect(experimentsResponse.ok()).toBe(true);
    const experiments = await experimentsResponse.json() as Array<{ id: number }>;
    experimentId = experiments[0]?.id;
    expect(experimentId, "seeded experiment required for setup chat").toBeDefined();
    await page.goto(`/f125/experiments/${experimentId}`, { waitUntil: "domcontentloaded" });
    const response = await sendThroughChatUi(page, `/api/experiments/${experimentId}/chat`);
    expect(response.ok, `Experiment chat failed (${response.status})`).toBe(true);
  } finally {
    if (experimentId !== undefined) await request.delete(`/api/chats/tune-session-${experimentId}`);
    await request.put("/api/settings", { data: original });
  }
});
