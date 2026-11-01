import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

test("analysis prompts save, survive reload, retain failed drafts and reset", async ({ page, request }) => {
  const original = await (await request.get("/api/settings")).json();
  await page.route("**/api/codex/status", (route) => route.fulfill({ json: { state: "not-signed-in", models: [] } }));
  const openSettings = async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
  };
  try {
    await request.put("/api/settings", { data: { lapAnalysisInstructions: null, compareAnalysisInstructions: null } });
    await openSettings();
    const lap = page.getByLabel("Lap analysis instructions", { exact: true });
    const compare = page.getByLabel("Comparison analysis instructions", { exact: true });
    const defaultLap = await lap.inputValue();
    await lap.fill("Focus on trail braking at T1.");
    await lap.locator("..").getByRole("button", { name: "Save", exact: true }).click();
    await expect(lap.locator("..").getByRole("status")).toHaveText("Saved");
    await compare.fill("Compare throttle pickup after the apex.");
    await compare.locator("..").getByRole("button", { name: "Save", exact: true }).click();
    await expect(compare.locator("..").getByRole("status")).toHaveText("Saved");
    await openSettings();
    await expect(lap).toHaveValue("Focus on trail braking at T1.");
    await expect(compare).toHaveValue("Compare throttle pickup after the apex.");
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") await route.fulfill({ status: 503, json: { error: "fixture failure" } });
      else await route.continue();
    });
    await lap.fill("Keep this unsaved draft.");
    await lap.locator("..").getByRole("button", { name: "Save", exact: true }).click();
    await expect(lap.locator("..").getByRole("alert")).toBeVisible();
    await expect(lap).toHaveValue("Keep this unsaved draft.");
    await page.unroute("**/api/settings");
    await lap.locator("..").getByRole("button", { name: "Restore default" }).click();
    await expect(lap).toHaveValue(defaultLap);
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).lapAnalysisInstructions).toBeNull();
    await page.screenshot({ path: test.info().outputPath("ai-prompt-settings.png"), fullPage: true });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await request.put("/api/settings", { data: { lapAnalysisInstructions: original.lapAnalysisInstructions, compareAnalysisInstructions: original.compareAnalysisInstructions } });
  }
});

test("Codex analysis selection uses discovered models without an API key", async ({ page, request }) => {
  const original = await (await request.get("/api/settings")).json();
  await page.route("**/api/codex/status", (route) => route.fulfill({ json: { state: "ready", models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] } }));
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "AI Analysis", exact: true }).click();
    await expect(page.getByText("ChatGPT connected. Select a model for lap analysis.")).toBeVisible();
    await page.locator("#ai-analysis-provider").click();
    await page.getByRole("option", { name: "Codex (ChatGPT)", exact: true }).click();
    await page.locator("#ai-analysis-model").click();
    await page.getByRole("option", { name: "GPT-6.1 Sol", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).aiModel).toBe("gpt-6.1-sol");
    expect(await (await request.get("/api/settings")).json()).toMatchObject({ aiProvider: "codex", aiModel: "gpt-6.1-sol" });
    await expect(page.getByText("Add this provider's API key above to load models.")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("codex-settings.png"), fullPage: true });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await request.put("/api/settings", { data: { aiProvider: original.aiProvider, aiModel: original.aiModel, aiThinkingBudget: original.aiThinkingBudget } });
  }
});

test("OpenAI-compatible can be selected for every AI feature without a stored key", async ({ page }) => {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    body.openaiCompatibleApiKeySet = false;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "AI Analysis" }).click();

  for (const index of [0, 1, 2, 3]) {
    const picker = page.getByLabel("Provider", { exact: true }).nth(index);
    await picker.click();
    const option = page.getByRole("option", { name: "OpenAI-compatible" });
    await expect(option).toBeEnabled();
    await option.click();
    await expect(picker).toHaveValue("OpenAI-compatible");
  }
});

test("AI settings classify empty models and recover from controlled API error", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const originalResponse = await request.get("/api/settings");
  expect(originalResponse.ok()).toBe(true);
  const original = (await originalResponse.json()) as Record<string, unknown>;
  let savedKeyPayload: Record<string, unknown> | null = null;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    body.openaiCompatibleApiKeySet = savedKeyPayload?.apiKey === "gateway-secret";
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/ai-key", async (route) => {
    savedKeyPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/ai-models**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ gemini: [], openai: [], "openai-compatible": [], _errors: {} }),
    });
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "AI Analysis" }).click();
    await expect(page.getByRole("heading", { name: "AI Analysis Provider" })).toBeVisible();
    await page.getByLabel("Provider").first().click();
    await page.getByRole("option", { name: "OpenAI-compatible" }).click();
    await page.getByRole("button", { name: "Edit" }).last().click();
    await expect(page.getByLabel("OpenAI-compatible API Key (optional)")).toBeVisible();
    await page.getByLabel("OpenAI-compatible API Key (optional)").fill("gateway-secret");
    await page.waitForTimeout(100);
    await page.getByLabel("OpenAI-compatible API Key (optional)").press("Tab");
    await expect.poll(() => savedKeyPayload).toEqual({ provider: "openai-compatible", apiKey: "gateway-secret" });
    await expect(page.getByLabel("OpenAI-compatible API Key (optional)")).toHaveAttribute("placeholder", /.+/);
    await expect(page.getByTitle("Clear stored key").first()).toBeVisible();
    await expect(page.getByText("No models returned for this provider.")).toBeVisible();

    await page.unroute("**/api/ai-models**");
    await page.route("**/api/ai-models**", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "seeded failure" }) });
    });
    await page.getByText("No models returned for this provider.").first().locator("..").getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Failed to refresh models" })).toBeVisible();

    await page.unroute("**/api/ai-models**");
    await page.route("**/api/ai-models**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ gemini: [], openai: [], "openai-compatible": [], _errors: {} }),
      });
    });
    await expect(page.getByText("No models returned for this provider.")).toBeVisible();
    expect(
      browserErrors.errors.filter((error) => !error.includes("/api/ai-models") && error !== "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)"),
    ).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await request.put("/api/settings", {
      data: {
        aiProvider: original.aiProvider,
        aiModel: original.aiModel,
        aiThinkingBudget: original.aiThinkingBudget,
        localEndpoint: original.localEndpoint,
      },
    });
  }
});
