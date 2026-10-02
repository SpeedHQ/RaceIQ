import { expect, test, type Page } from "@playwright/test";
import type { GameId } from "@raceiq/games/ids";
import { completeOnboarding } from "../../support/tunes";
import { cleanDisposable, importDisposableLap, lapsFor, sessionsFor, type DisposableImport } from "../sessions/helpers";

const games = [
  { gameId: "fm-2023", prefix: "fm23" },
  { gameId: "ac-evo", prefix: "ac-evo" },
] as const;

async function createSetup(page: Page, gameId: GameId, carOrdinal: number) {
  const name = `Deletion regression ${gameId} ${crypto.randomUUID()}`;
  const settings = gameId === "fm-2023" ? {
    tires: { frontPressure: 30, rearPressure: 30 },
    gearing: { finalDrive: 3 },
    alignment: { frontCamber: -1, rearCamber: -1, frontToe: 0, rearToe: 0 },
    antiRollBars: { front: 20, rear: 20 },
    springs: { frontRate: 750, rearRate: 750, frontHeight: 5, rearHeight: 5 },
    damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
    aero: { frontDownforce: 180, rearDownforce: 220 },
    differential: { rearAccel: 70, rearDecel: 45 },
    brakes: { balance: 55, pressure: 100 },
  } : {};
  const response = await page.request.post("/api/tunes", {
    data: { gameId, carOrdinal, name, author: "Deletion regression", category: "road", settings },
  });
  expect(response.status()).toBe(201);
  const setup = await response.json() as { id: number; name: string };
  return setup;
}

async function openDelete(page: Page, prefix: string, name: string) {
  await page.goto(`/${prefix}/setups`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Yours", exact: true }).click();
  await page.getByText(name, { exact: true }).click();
  await page.getByRole("table").getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete setup?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(name);
  return dialog;
}

async function removeSetup(page: Page, id: number) {
  const response = await page.request.delete(`/api/tunes/${id}?confirmInUse=true`);
  expect([200, 404]).toContain(response.status());
}

test.beforeEach(async ({ page }) => {
  await completeOnboarding(page);
});

for (const { gameId, prefix } of games) {
  test(`${gameId}: linked deletion lists sessions and laps, cancels safely, then unlinks without deleting recordings`, async ({ page }) => {
    const imports: DisposableImport[] = [];
    let setupId: number | undefined;
    try {
      const source = (await lapsFor(page.request, gameId))[0];
      if (!source) throw new Error(`${gameId} needs a recorded source lap`);
      imports.push(await importDisposableLap(page.request, gameId, `setup-delete-first-${gameId}`, source.id));
      imports.push(await importDisposableLap(page.request, gameId, `setup-delete-second-${gameId}`, source.id));
      const importedIds = imports.flatMap((item) => item.lapIds);
      const beforeLaps = (await lapsFor(page.request, gameId)).filter((lap) => importedIds.includes(lap.id));
      const carOrdinal = beforeLaps[0]?.carOrdinal;
      if (carOrdinal == null) throw new Error(`${gameId} disposable lap has no car ordinal`);
      const setup = await createSetup(page, gameId, carOrdinal);
      setupId = setup.id;
      for (const lap of beforeLaps) {
        const response = await page.request.patch(`/api/laps/${lap.id}/tune`, { data: { tuneId: setup.id } });
        expect(response.ok()).toBe(true);
      }

      const dialog = await openDelete(page, prefix, setup.name);
      await expect(dialog).toContainText(/in use/i);
      await expect(dialog).toContainText(/recordings will not be deleted/i);
      for (const item of imports) {
        for (const sessionId of item.sessionIds) {
          const sessionLabel = dialog.getByText(new RegExp(`Session ${sessionId} ·`));
          await expect(sessionLabel).toBeVisible();
          const displayed = await sessionLabel.locator("..").getByText(/Linked lap numbers:/).innerText();
          const actualNumbers = displayed.split(":")[1].split(",").map(Number).sort((a, b) => a - b);
          const expectedNumbers = beforeLaps.filter((lap) => lap.sessionId === sessionId).map((lap) => lap.lapNumber).sort((a, b) => a - b);
          expect(actualNumbers).toEqual(expectedNumbers);
        }
      }
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(200);
      const afterCancel = await lapsFor(page.request, gameId);
      for (const lap of beforeLaps) expect(afterCancel.find((row) => row.id === lap.id)?.tuneId).toBe(setup.id);

      await page.getByRole("table").getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByText(setup.name, { exact: true })).toHaveCount(0);
      expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(404);
      const afterDelete = await lapsFor(page.request, gameId);
      const remainingSessions = await sessionsFor(page.request, gameId);
      for (const lap of beforeLaps) {
        const remaining = afterDelete.find((row) => row.id === lap.id);
        expect(remaining).toBeDefined();
        expect(remaining?.tuneId ?? null).toBeNull();
        expect(remaining?.lapTime).toBe(lap.lapTime);
      }
      for (const sessionId of imports.flatMap((item) => item.sessionIds)) {
        expect(remainingSessions.some((session) => session.id === sessionId)).toBe(true);
      }
    } finally {
      for (const item of imports) await cleanDisposable(page.request, item, gameId);
      if (setupId != null) await removeSetup(page, setupId);
    }
  });

  test(`${gameId}: unlinked setup still requires confirmation`, async ({ page }) => {
    const setup = await createSetup(page, gameId, 1);
    try {
      const dialog = await openDelete(page, prefix, setup.name);
      await expect(dialog).toContainText(/not linked to sessions or laps/i);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(200);
      await page.getByRole("table").getByRole("button", { name: "Delete", exact: true }).click();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(404);
    } finally {
      await removeSetup(page, setup.id);
    }
  });
}

test("setup deletion cannot proceed while usage is unknown or failed", async ({ page }) => {
  const setup = await createSetup(page, "ac-evo", 1);
  let releaseUsage!: () => void;
  const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
  const usagePath = `**/api/tunes/${setup.id}/usage`;
  try {
    await page.route(usagePath, async (route) => {
      const response = await route.fetch();
      await usageGate;
      await route.fulfill({ response });
    });
    const dialog = await openDelete(page, "ac-evo", setup.name);
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    releaseUsage();
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.unroute(usagePath);
    await page.route(usagePath, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Usage service unavailable" }) }));
    await page.getByRole("table").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(200);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    releaseUsage();
    await page.unroute(usagePath);
    await removeSetup(page, setup.id);
  }
});

test("failed setup deletion remains visible and can be retried without losing setup", async ({ page }) => {
  const setup = await createSetup(page, "ac-evo", 1);
  const deletePath = `**/api/tunes/${setup.id}?confirmInUse=true`;
  try {
    await page.route(deletePath, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Deletion temporarily unavailable" }) }));
    const dialog = await openDelete(page, "ac-evo", setup.name);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(200);
    await page.unroute(deletePath);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await page.request.get(`/api/tunes/${setup.id}`)).status()).toBe(404);
  } finally {
    await page.unroute(deletePath);
    await removeSetup(page, setup.id);
  }
});
