import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { collectBrowserErrors } from "../../support/browser-errors";

type ImportedSession = { sessionId: number; lapId: number };

async function importOpponentSession(request: APIRequestContext, identity: string): Promise<ImportedSession> {
  const response = await request.post("/api/laps/import", {
    timeout: 120_000,
    multipart: {
      file: { name: `${identity}.bin.gz`, mimeType: "application/octet-stream", buffer: makeLmuOpponentCapture({ identity }) },
      ownership: "mine",
    },
  });
  expect(response.ok(), "controlled native opponent import").toBe(true);
  const imported = await response.json() as { laps?: ImportedSession[] };
  expect(imported.laps?.length).toBeGreaterThan(0);
  const sessions = [...new Set(imported.laps!.map(({ sessionId }) => sessionId))];
  expect(sessions).toHaveLength(1);
  return { sessionId: sessions[0]!, lapId: imported.laps![0]!.lapId };
}

async function openStorage(page: Page, request: APIRequestContext) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(async () => {
    const status = await (await request.get("/api/sessions/classification-migration-status")).json();
    return status.pending + status.running;
  }, { timeout: 60_000 }).toBe(0);
  await expect(page.getByRole("button", { name: /^(Open navigation|Settings)$/ }).filter({ visible: true }).first()).toBeVisible();
  const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.locator('button[data-slot="button"][aria-label="Settings"]').filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: /^(Open settings menu|Storage)$/ }).filter({ visible: true }).first()).toBeVisible();
  const settingsMenu = page.getByRole("button", { name: "Open settings menu", exact: true });
  if (await settingsMenu.isVisible()) await settingsMenu.click();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
}

test("LMU opponent removal previews without mutation, confirms whole-session removal, preserves player laps", async ({ page, request }) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const identity = `strip-${crypto.randomUUID()}`;
  const ids: number[] = [];
  let playerLapIdsBefore: number[] = [];
  let playerExportIds: number[] = [];
  try {
    const first = await importOpponentSession(request, `${identity}-one`);
    ids.push(first.sessionId);
    const second = await importOpponentSession(request, `${identity}-two`);
    ids.push(second.sessionId);
    const lapsBefore = await request.get("/api/laps?gameId=lmu");
    expect(lapsBefore.ok()).toBe(true);
    playerLapIdsBefore = ((await lapsBefore.json()) as { id: number; sessionId: number }[])
      .filter((lap) => ids.includes(lap.sessionId)).map(({ id }) => id);
    expect(playerLapIdsBefore.length).toBeGreaterThan(0);
    playerExportIds = [...playerLapIdsBefore];
    const initialStatus = await (await request.get("/api/storage/session-opponents")).json();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await openStorage(page, request);
      const section = page.getByRole("region", { name: "Remove saved opponent data" });
      await expect(section).toBeVisible();
      const checkboxes = ids.map((id) => section.getByLabel(new RegExp(`#${id}\\b`)));
      await checkboxes[0]!.check();
      await section.getByRole("button", { name: "Preview removal" }).click();
      const dialog = page.getByRole("dialog", { name: "Remove saved opponent data" });
      await expect(dialog).toContainText(`#${ids[0]}`);
      await expect(dialog).toContainText("Removable companion data:");
      expect(await (await request.get("/api/storage/session-opponents")).json()).toEqual(initialStatus);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      const afterCancel = await request.get("/api/laps?gameId=lmu");
      expect(afterCancel.ok()).toBe(true);
      expect(((await afterCancel.json()) as { id: number }[]).map(({ id }) => id)).toEqual(expect.arrayContaining(playerLapIdsBefore));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }

    await page.getByRole("region", { name: "Remove saved opponent data" }).getByLabel(new RegExp(`#${ids[0]}\\b`)).check();
    const section = page.getByRole("region", { name: "Remove saved opponent data" });
    await section.getByLabel(new RegExp(`#${ids[1]}\\b`)).check();
    await section.getByRole("button", { name: "Preview removal" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "Remove saved opponent data" });
    await expect(confirmDialog).toContainText(`#${ids[0]}`);
    await expect(confirmDialog).toContainText(`#${ids[1]}`);
    await expect(confirmDialog).toContainText("every lap");
    await confirmDialog.getByRole("button", { name: "Permanently remove opponent data" }).focus();
    let removalRequests = 0;
    page.on("request", (candidate) => {
      if (candidate.url().endsWith("/api/storage/session-opponents") && candidate.method() === "POST") removalRequests++;
    });
    const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/storage/session-opponents") && candidate.request().method() === "POST");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    expect((await response).status()).toBe(202);
    await expect(confirmDialog).toBeHidden();
    expect(removalRequests).toBe(1);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openStorage(page, request);
    await expect(confirmDialog).toBeHidden();
    await expect.poll(async () => {
      const status = await (await request.get("/api/storage/session-opponents")).json();
      return status.status === "running" ? null : status;
    }, { timeout: 60_000 }).toMatchObject({ status: "success", removedSessionIds: expect.arrayContaining(ids), cleanupPendingSessionIds: [] });
    const finalStatus = await (await request.get("/api/storage/session-opponents")).json() as { freedBytes: number; removedSessionIds: number[]; status: string; cleanupPendingSessionIds: number[] };
    expect(finalStatus.freedBytes).toBeGreaterThan(0);
    expect(finalStatus.removedSessionIds).toEqual(expect.arrayContaining(ids));
    expect(finalStatus.cleanupPendingSessionIds).toEqual([]);
    await expect(section.getByText(/Removed from 2 sessions/)).toBeVisible();
    const lapsAfter = await request.get("/api/laps?gameId=lmu");
    expect(lapsAfter.ok()).toBe(true);
    expect(((await lapsAfter.json()) as { id: number }[]).map(({ id }) => id)).toEqual(expect.arrayContaining(playerLapIdsBefore));
    for (const lapId of playerExportIds) {
      expect((await request.get(`/api/laps/${lapId}/export-bin`)).ok(), `player replay export ${lapId} after removal`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openStorage(page, request);
    await expect(page.getByRole("region", { name: "Remove saved opponent data" }).getByText(/Removed from 2 sessions/)).toBeVisible();
    const removedSection = page.getByRole("region", { name: "Remove saved opponent data" });
    await removedSection.getByLabel(new RegExp(`#${ids[0]}\\b`)).check();
    await removedSection.getByRole("button", { name: "Preview removal" }).click();
    const removedPreview = page.getByRole("dialog", { name: "Remove saved opponent data" });
    await expect(removedPreview).toContainText("Opponent data already removed");
    await page.keyboard.press("Escape");
    await expect(removedPreview).toBeHidden();
    expect(browserErrors.errors).toEqual([]);
  } finally {
    if (ids.length) {
      const cleanup = await request.post("/api/sessions/bulk-delete", { data: { ids } });
      expect(cleanup.ok(), "remove disposable imported sessions").toBe(true);
    }
  }
});
