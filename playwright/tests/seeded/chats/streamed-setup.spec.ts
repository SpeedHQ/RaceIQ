import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../../support/browser-errors";
import { ExperimentSchema, SEEDED_CHAT_STREAM } from "./helpers";
import { z } from "zod";

test("Setup chat submits a prompt and renders a streamed response", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const experimentsResponse = await request.get("/api/experiments?gameId=f1-2025");
  expect(experimentsResponse.ok(), "seeded F1 tuning experiments").toBe(true);
  const experiment = z.array(ExperimentSchema).parse(await experimentsResponse.json())[0];
  if (!experiment) throw new Error("Missing seeded F1 experiment for streamed chat");

  const threadId = `tune-session-${experiment.id}`;
  let compacted = false;
  await page.route(`**/api/chats/${threadId}/generations`, (route) =>
    route.fulfill({
      json: {
        activeThreadId: compacted ? `${threadId}~g2` : threadId,
        generations: compacted
          ? [
              { threadId, generation: 1, active: false },
              { threadId: `${threadId}~g2`, generation: 2, active: true },
            ]
          : [{ threadId, generation: 1, active: true }],
      },
    }),
  );
  await page.route(`**/api/chats/${threadId}/run`, (route) => route.fulfill({ json: { status: "none" } }));
  await page.route("**/api/chats/*/compact", async (route) => {
    compacted = true;
    await route.fulfill({ json: { generation: 2 } });
  });

  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const settings = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...settings, aiProvider: "local", aiModel: "seeded-e2e" },
    });
  });

  let submittedPrompt = "";
  await page.route(`**/api/experiments/${experiment.id}/chat*`, async (route) => {
    if (route.request().method() !== "POST") {
      const generation = new URL(route.request().url()).searchParams.get("gen");
      if (generation === "2") {
        await route.fulfill({ json: { messages: [] } });
      } else {
        await route.continue();
      }
      return;
    }
    submittedPrompt = route.request().postData() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      body: SEEDED_CHAT_STREAM,
    });
  });

  await page.goto(`/f125/experiments/${experiment.id}`, { waitUntil: "domcontentloaded" });
  const prompt = "Explain this seeded setup";
  const messageInput = page.getByRole("textbox", { name: "Message input" });
  await expect(messageInput).toBeVisible({ timeout: 30_000 });
  await messageInput.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submittedPrompt).toContain(prompt);
  await expect(page.getByText("Seeded streamed reply", { exact: true })).toBeVisible();
  const compactButton = page.getByRole("button", { name: "Compact & New chat" });
  await expect(compactButton).toBeEnabled();
  await compactButton.click({ force: true });
  await expect.poll(() => compacted).toBe(true);
  await expect(page.getByText("gen 2/2", { exact: true })).toBeVisible();
  await expect(page.getByText("Seeded streamed reply", { exact: true })).toHaveCount(0);
  expect(browserErrors.errors, "unexpected browser errors during streamed chat").toEqual([]);
});
