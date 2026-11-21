import { expect, test } from "@playwright/test";

import { collectBrowserErrors } from "../../support/browser-errors";

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

  await expect(page.getByRole("combobox", { name: /^(Thinking|Reasoning) level$/ })).toHaveCount(0);
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

test("OpenAI analysis and chat reasoning levels persist independently", async ({ page, request }) => {
  const initial = await request.get("/api/settings");
  expect(initial.ok()).toBe(true);
  const { aiProvider, aiModel, aiReasoningLevel, chatProvider, chatModel, chatReasoningLevel } = await initial.json();
  const model = "gpt-5.4-mini";
  const openSettings = async () => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "AI Analysis" }).click();
  };
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), openaiApiKeySet: true } });
  });
  await page.route("**/api/ai-models**", (route) => route.fulfill({
    json: { openai: [model, "gpt-4.1-mini", "gpt-6.2-sol"].map((id) => ({ id, name: id })), _errors: {} },
  }));
  const analysis = page.locator("#ai-analysis-reasoning");
  const chat = page.locator("#ai-chat-reasoning");
  const popup = page.getByRole("listbox");
  const selectLevel = async (picker: typeof analysis, label: string) => {
    await picker.click();
    await popup.getByRole("option", { name: label, exact: true }).click();
  };
  const levels = async () => {
    const settings = await (await request.get("/api/settings")).json();
    return [settings.aiReasoningLevel, settings.chatReasoningLevel];
  };
  try {
    expect((await request.put("/api/settings", { data: {
      aiProvider: "openai", aiModel: model, aiReasoningLevel: "medium",
      chatProvider: "openai", chatModel: model, chatReasoningLevel: "medium",
    } })).ok()).toBe(true);
    await openSettings();
    await expect(analysis).toHaveValue("Medium ⭐");
    await expect(chat).toHaveValue("Medium ⭐");
    const options = ["None", "Minimal", "Low", "Medium ⭐", "High", "XHigh", "Max"];
    for (const picker of [analysis, chat]) {
      await picker.click();
      await expect(popup.getByRole("option")).toHaveText(options);
      await picker.press("Escape");
      await expect(popup).toBeHidden();
    }
    await analysis.focus();
    await analysis.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(analysis).toBeFocused();
    await analysis.press("ArrowDown");
    await expect(popup).toBeVisible();
    await analysis.fill("None");
    await expect(popup.getByRole("option")).toHaveText(["None"]);
    await analysis.press("ArrowDown");
    await analysis.press("Enter");
    await expect(analysis).toHaveValue("None");
    await expect.poll(levels).toEqual(["none", "medium"]);
    await openSettings();
    await expect(analysis).toHaveValue("None");
    await expect(chat).toHaveValue("Medium ⭐");
    await selectLevel(chat, "Max");
    await selectLevel(analysis, "High");
    await expect.poll(levels).toEqual(["high", "max"]);
    const invalid = await request.put("/api/settings", { data: { aiReasoningLevel: "low", chatReasoningLevel: "invalid" } });
    expect(invalid.status()).toBe(400);
    await expect.poll(levels).toEqual(["high", "max"]);
    expect((await request.put("/api/settings", { data: { aiModel: "gpt-4.1-mini", chatModel: "gpt-6.2-sol" } })).ok()).toBe(true);
    await openSettings();
    await expect(analysis).toBeEnabled();
    await expect(analysis).toHaveValue("High");
    await expect(chat).toBeEnabled();
    await expect(chat).toHaveValue("Max");
    await chat.click();
    await expect(popup.getByRole("option", { name: "None", exact: true })).toHaveCount(1);
    await chat.press("Escape");
    expect((await request.put("/api/settings", { data: { aiProvider: "openai-compatible", chatModel: model } })).ok()).toBe(true);
    await openSettings();
    await expect(analysis).toHaveCount(0);
    await expect(chat).toHaveValue("Max");
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT" && route.request().postDataJSON().chatReasoningLevel === "medium") {
        return route.fulfill({ status: 503, body: "Temporarily unavailable" });
      }
      await route.fallback();
    });
    await selectLevel(chat, "Medium ⭐");
    await expect(page.getByText("Service Unavailable", { exact: true })).toBeVisible();
    await expect.poll(levels).toEqual(["high", "max"]);
  } finally {
    await page.close();
    await request.put("/api/settings", { data: { aiProvider, aiModel, aiReasoningLevel, chatProvider, chatModel, chatReasoningLevel } });
  }
});
