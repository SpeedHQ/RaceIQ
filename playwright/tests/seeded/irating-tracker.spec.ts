import { expect, test, type Page } from "@playwright/test";
import { completeOnboarding } from "../support/tunes";

const CALLBACK_PATH = "/api/iracing-rating/callback";

async function connect(page: Page) {
  const connected = page.waitForURL((url) => url.pathname === "/iracing/rating" && url.searchParams.get("rating") === "connected");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await connected;
  await expect(page.getByText("RaceIQ Fixture Driver", { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await completeOnboarding(page);
  await page.goto("/iracing/rating");
  const fixture = new URL(page.url());
  fixture.hostname = "127.0.0.1";
  fixture.port = String(Number(fixture.port) + 20_000);
  const reset = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { status: 200, customerId: 424242, empty: false, refreshStatus: 200, isolate: true } });
  expect(reset.ok()).toBe(true);
  const clientStatus = await page.request.get("/api/iracing-rating/status");
  expect(clientStatus.ok()).toBe(true);
  if ((await clientStatus.json() as { configured: boolean }).configured) {
    const removed = await page.request.delete("/api/iracing-rating/client");
    expect([200, 204]).toContain(removed.status());
  }
});

test.afterEach(async ({ page }) => {
  await page.goto("/iracing/rating");
  const fixture = new URL(page.url());
  fixture.hostname = "127.0.0.1";
  fixture.port = String(Number(fixture.port) + 20_000);
  const reset = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { status: 200, customerId: 424242, empty: false, refreshStatus: 200 } });
  expect(reset.ok()).toBe(true);
  const response = await page.request.delete("/api/iracing-rating/client");
  expect([200, 204]).toContain(response.status());
});

test("iRacing OAuth imports and displays idempotent category rating progression", async ({ page }) => {
  await page.goto("/iracing");
  await page.getByRole("link", { name: "iRating tracker", exact: true }).click();
  await expect(page).toHaveURL(/\/iracing\/rating$/);
  await expect(page.getByRole("heading", { name: "iRating tracker" })).toBeVisible();
  await expect(page.getByLabel("Client ID")).toBeVisible();

  const origin = new URL(page.url()).origin;
  await page.getByLabel("Client ID").fill("raceiq-e2e-client");
  await page.getByLabel("Client secret").fill("fixture-client-secret");
  await page.getByLabel("Redirect URI").fill(new URL(CALLBACK_PATH, origin).toString());
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await expect(page.getByText("Connect your iRacing account to sync your ratings.", { exact: true })).toBeVisible();

  const statusBeforeConnect = await page.request.get("/api/iracing-rating/status");
  expect(statusBeforeConnect.ok()).toBe(true);
  expect(await statusBeforeConnect.text()).not.toContain("fixture-client-secret");
  await connect(page);
  const fixture = new URL(origin);
  fixture.hostname = "127.0.0.1";
  fixture.port = String(Number(fixture.port) + 20_000);
  const stateResponse = await page.request.get(new URL("/fixtures/last-state", fixture).toString());
  const { state } = await stateResponse.json() as { state: string };
  const replay = await page.request.get(`${CALLBACK_PATH}?code=fixture-authorization-code&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
  expect(replay.status()).toBe(302);
  expect(replay.headers().location).toContain("rating=error");
  expect((await (await page.request.get("/api/iracing-rating/status")).json() as { connected: boolean }).connected).toBe(true);
  await expect(page.getByText("No completed races with available iRating data yet. Sync again after your next race.", { exact: true })).toBeVisible();

  const emptySource = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { empty: true } });
  expect(emptySource.ok()).toBe(true);
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByText("No completed races with available iRating data yet. Sync again after your next race.", { exact: true })).toBeVisible();
  const populatedSource = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { empty: false } });
  expect(populatedSource.ok()).toBe(true);
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();
  await expect(page.getByText("1550", { exact: true })).toBeVisible();
  await expect(page.getByText("+8", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();
  await expect(page.getByText("+32", { exact: true })).toBeVisible();
  await expect(page.getByText("1688", { exact: true })).toBeVisible();
  await expect(page.getByText("-32", { exact: true })).toBeVisible();
  await expect(page.getByText("RaceIQ Fixture Driver", { exact: true })).toBeVisible();
  const repeatedSync = page.waitForResponse((response) => response.url().endsWith("/api/iracing-rating/sync") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await repeatedSync;

  const historyBeforeDisconnect = await page.request.get("/api/iracing-rating/history");
  expect(historyBeforeDisconnect.ok()).toBe(true);
  const firstHistory = await historyBeforeDisconnect.json() as { entries: Array<{ observedAt: string; categoryId: number; irating: number; change: number }> };
  expect(firstHistory.entries.map(({ observedAt, categoryId, irating, change }) => ({ observedAt: new Date(observedAt).toISOString(), categoryId, irating, change }))).toEqual([
    { observedAt: "2026-10-16T19:15:00.000Z", categoryId: 2, irating: 1510, change: 30 },
    { observedAt: "2026-10-18T16:30:00.000Z", categoryId: 1, irating: 1688, change: -32 },
    { observedAt: "2026-10-18T16:30:00.000Z", categoryId: 2, irating: 1550, change: 8 },
    { observedAt: "2026-10-20T18:00:00.000Z", categoryId: 2, irating: 1542, change: 32 },
  ]);

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Connect your iRacing account to sync your ratings.", { exact: true })).toBeVisible();
  await connect(page);
  const historyAfterReconnect = await page.request.get("/api/iracing-rating/history");
  expect(historyAfterReconnect.ok()).toBe(true);
  const persistedHistory = await historyAfterReconnect.json() as { entries: Array<{ observedAt: string; categoryId: number; irating: number; change: number }> };
  expect(persistedHistory.entries).toEqual(firstHistory.entries);
  await page.getByLabel("Client ID").fill("raceiq-e2e-client-replaced");
  await page.getByLabel("Client secret").fill("fixture-client-secret-replaced");
  await page.getByLabel("Redirect URI").fill(new URL(CALLBACK_PATH, origin).toString());
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await expect(page.getByText("Connect your iRacing account to sync your ratings.", { exact: true })).toBeVisible();
  await connect(page);
  const historyAfterClientChange = await page.request.get("/api/iracing-rating/history");
  expect(historyAfterClientChange.ok()).toBe(true);
  expect(await historyAfterClientChange.json()).toEqual(persistedHistory);


  await page.getByRole("button", { name: "Remove client", exact: true }).click();
  await expect(page.getByText("OAuth client credentials are configured. The client secret is never shown here.", { exact: true })).toHaveCount(0);
  await page.getByLabel("Client ID").fill("raceiq-e2e-client-replaced");
  await page.getByLabel("Client secret").fill("fixture-client-secret-replaced");
  await page.getByLabel("Redirect URI").fill(new URL(CALLBACK_PATH, origin).toString());
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await connect(page);
  const historyAfterClientRemoval = await page.request.get("/api/iracing-rating/history");
  expect(historyAfterClientRemoval.ok()).toBe(true);
  expect(await historyAfterClientRemoval.json()).toEqual(persistedHistory);
  const finalStatus = await page.request.get("/api/iracing-rating/status");
  expect(finalStatus.ok()).toBe(true);
  const finalBody = await finalStatus.text();
  expect(finalBody).not.toContain("fixture-client-secret");
  expect(finalBody).not.toContain("fixture-access-token");
});

test("iRacing callback rejects invalid OAuth state without connecting", async ({ page }) => {
  const response = await page.request.get(`${CALLBACK_PATH}?code=fixture-authorization-code&state=invalid`, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toContain("rating=error");
  await page.goto(response.headers().location ?? "/iracing/rating?rating=error");
  await expect(page.getByRole("alert").getByText("iRacing authorization failed. Check client credentials and registered redirect URI, then retry.", { exact: true })).toBeVisible();
  const status = await page.request.get("/api/iracing-rating/status");
  expect(status.ok()).toBe(true);
  expect((await status.json() as { connected: boolean }).connected).toBe(false);
  const missingState = await page.request.get(`${CALLBACK_PATH}?code=fixture-authorization-code`, { maxRedirects: 0 });
  expect(missingState.status()).toBe(302);
  expect(missingState.headers().location).toContain("rating=error");
});
test("iRacing sync failure preserves previously imported rating history", async ({ page }) => {
  await page.goto("/iracing/rating");
  await page.getByLabel("Client ID").fill("raceiq-e2e-client");
  await page.getByLabel("Client secret").fill("fixture-client-secret");
  const origin = new URL(page.url()).origin;
  const fixture = new URL(origin);
  fixture.hostname = "127.0.0.1";
  fixture.port = String(Number(fixture.port) + 20_000);
  const account = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { customerId: 424243 } });
  expect(account.ok()).toBe(true);
  await page.getByLabel("Redirect URI").fill(new URL(CALLBACK_PATH, origin).toString());
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await connect(page);
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();

  const failure = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { status: 503 } });
  expect(failure.ok()).toBe(true);
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByRole("alert").getByText("Could not load iRating data. Try again.", { exact: true })).toBeVisible();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();
  const rateLimited = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { status: 429 } });
  expect(rateLimited.ok()).toBe(true);
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByRole("alert").getByText("Could not load iRating data. Try again.", { exact: true })).toBeVisible();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();
  const refreshFailure = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { refreshStatus: 503 } });
  expect(refreshFailure.ok()).toBe(true);
  await page.getByRole("button", { name: "Sync ratings", exact: true }).click();
  await expect(page.getByRole("alert").getByText("Connect your iRacing account to view history.", { exact: true })).toBeVisible();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();
  const refreshRecovery = await page.request.post(new URL("/fixtures/control", fixture).toString(), { data: { refreshStatus: 200 } });
  expect(refreshRecovery.ok()).toBe(true);
  await page.reload();
  await expect(page.getByText("RaceIQ Fixture Driver", { exact: true })).toBeVisible();
  await expect(page.getByText("1542", { exact: true })).toBeVisible();
});
