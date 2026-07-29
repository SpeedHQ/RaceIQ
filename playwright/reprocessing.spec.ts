import { expect, type Page, test } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  const response = await request.put("/api/settings", {
    data: { onboardingComplete: true, driverName: "TestDriver" },
  });
  expect(response.ok()).toBeTruthy();
});

async function mockStaleSessionNotification(page: Page) {
  let sendToPage: ((message: string) => void) | null = null;
  let markReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  await page.routeWebSocket("**/ws", (socket) => {
    sendToPage = (message) => socket.send(message);
    markReady?.();
  });

  return {
    ready,
    send() {
      if (!sendToPage) throw new Error("Mock WebSocket is not connected");
      sendToPage(
        JSON.stringify({
          type: "stale-lap-detection",
          sessionCount: 1,
          currentVersion: "test",
        }),
      );
    },
    sendProgress() {
      if (!sendToPage) throw new Error("Mock WebSocket is not connected");
      sendToPage(JSON.stringify({ type: "lap-reprocessed" }));
    },
  };
}

test("failed reprocessing exposes Retry and supports keyboard dismissal", async ({ page }) => {
  const socket = await mockStaleSessionNotification(page);
  await page.route("**/api/sessions/reprocess-stale", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporarily unavailable" }),
    }),
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await socket.ready;
  socket.send();

  await page.getByRole("button", { name: "Reparse 1 session" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Reprocessing failed" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();

  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Reparse 1 session" })).toBeVisible();
});

test("Retry completes successfully and clears the stale-session action", async ({ page }) => {
  const socket = await mockStaleSessionNotification(page);
  let attempts = 0;
  await page.route("**/api/sessions/reprocess-stale", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort("failed");
      return;
    }
    socket.sendProgress();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reprocessed: 1, results: [] }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await socket.ready;
  socket.send();

  await page.getByRole("button", { name: "Reparse 1 session" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Reprocessing failed" })).toBeVisible();

  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByRole("heading", { name: "Reprocessing complete" })).toBeVisible();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  expect(attempts).toBe(2);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Reparse 1 session" })).toHaveCount(0);
});

test("an in-flight request can be dismissed without exposing a duplicate action", async ({ page }) => {
  const socket = await mockStaleSessionNotification(page);
  let releaseResponse: (() => void) | null = null;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  await page.route("**/api/sessions/reprocess-stale", async (route) => {
    await responseGate;
    socket.sendProgress();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reprocessed: 1, results: [] }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await socket.ready;
  socket.send();

  await page.getByRole("button", { name: "Reparse 1 session" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Reparse 1 session" })).toHaveCount(0);

  const responseFinished = page.waitForResponse((response) => response.url().endsWith("/api/sessions/reprocess-stale") && response.status() === 200);
  releaseResponse?.();
  await responseFinished;
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reparse 1 session" })).toHaveCount(0);
});
