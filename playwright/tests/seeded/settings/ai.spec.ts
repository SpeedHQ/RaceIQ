import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

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
    savedKeyPayload = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
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
    await page.getByLabel("Provider").first().selectOption("openai-compatible");
    await expect(page.getByLabel("OpenAI-compatible API Key (optional)")).toBeVisible();
    await page.getByLabel("OpenAI-compatible API Key (optional)").fill("gateway-secret");
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
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
    await page.unroute("**/api/ai-models**");
    await page.unroute("**/api/ai-key");
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
