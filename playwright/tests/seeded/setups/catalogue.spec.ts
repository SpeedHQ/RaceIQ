import { expect, test, type Page } from "@playwright/test";

import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";
type SetupRecord = Record<string, unknown>;

function objectRows(value: unknown): SetupRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is SetupRecord => typeof row === "object" && row !== null);
}

function stringValue(row: SetupRecord, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function assertPaginationAndFilters(page: Page, firstAuthor?: string) {
  const rows = page.getByRole("row").nth(1);
  await expect(rows).toBeVisible({ timeout: 15_000 });

  const authorFilter = page.getByPlaceholder(/search author/i);
  await expect(authorFilter).toBeVisible();
  if (firstAuthor) {
    await authorFilter.fill(firstAuthor);
    await expect(rows).toBeVisible();
    await authorFilter.fill("");
  }

  const pagination = page.getByText(/\d+[–-]\d+ of \d+ · page \d+\/\d+/i);
  await expect(pagination).toBeVisible();
  const summary = await pagination.innerText();
  const pageMatch = summary.match(/page\s+1\/(\d+)/i);
  const pageCount = Number(pageMatch?.[1] ?? "1");
  if (pageCount > 1) {
    await page.getByRole("button", { name: /next/i }).click();
    await expect(page.getByText(/page\s+2\//i)).toBeVisible();
    await page.getByRole("button", { name: /prev/i }).click();
    await expect(page.getByText(/page\s+1\//i)).toBeVisible();
  }

  const filters = page.getByRole("main").getByRole("combobox");
  await expect(filters).toHaveCount(2);
  for (const index of [0, 1]) {
    const filter = filters.nth(index);
    await filter.click();
    const listboxId = await filter.getAttribute("aria-controls");
    expect(listboxId).not.toBeNull();
    const listbox = page.locator(`[id="${listboxId}"]`);
    await expect(listbox).toBeVisible();
    const options = listbox.getByRole("option");
    await expect(options.first()).toBeVisible();
    if ((await options.count()) > 1) {
      const selectedLabel = (await options.nth(1).innerText()).trim();
      await options.nth(1).click();
      await expect(filter).toHaveValue(selectedLabel);
    } else {
      await page.keyboard.press("Escape");
    }
  }
}

async function mockSetupManagerApis(page: Page) {
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/settings", (route) => route.fulfill({
    json: { onboardingComplete: true, gameId: "acc" },
  }));
  await page.route("**/api/tunes/setup-files*", (route) => route.fulfill({
    json: {
      baseDir: "C:\\Setups",
      files: [{
        carModel: "ferrari_296_gt3",
        trackName: "spa",
        fileName: "Race.json",
        absolutePath: "C:\\Setups\\ferrari_296_gt3\\spa\\Race.json",
      }],
    },
  }));
  await page.route("**/api/setup-backups*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/setup-backups/google/status") {
      return route.fulfill({ json: { status: "connected" } });
    }
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 409,
        json: { error: "A backup with this name already exists.", code: "duplicate-name" },
      });
    }
    return route.fulfill({
      json: {
        backups: [{
          valid: true,
          id: "backup-1",
          gameId: "acc",
          carId: "ferrari_296_gt3",
          trackId: "spa",
          setupName: "Race",
          updatedAt: "2026-08-20T10:00:00.000Z",
        }],
      },
    });
  });
}

test("F1 2025 setup catalogue supports filters and pagination without unsupported CRUD controls", async ({ page }) => {
  const game = SEEDED_GAME_CASES.find(({ gameId }) => gameId === "f1-2025");
  if (!game) throw new Error("Missing canonical F1 seeded game case");
  const browserErrors = collectBrowserErrors(page);
  const response = await page.request.get("/api/f1-25/setups");
  expect(response.ok(), "F1 setup catalogue API").toBe(true);
  const payload: unknown = await response.json();
  const tracks = objectRows(payload);
  const firstSetup = tracks.flatMap((track) => objectRows(track.setups)).find((setup) => stringValue(setup, "author"));
  const author = firstSetup ? stringValue(firstSetup, "author") : undefined;

  await page.goto(`/${game.prefix}/setups`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible({ timeout: 15_000 });
  await assertPaginationAndFilters(page, author);

  // F1 endpoint is bundled community evidence and browser is intentionally read-only.
  // Absence of owner actions classifies CRUD/import as unsupported, rather than faking writes.
  await expect(page.getByRole("button", { name: /new tune|import|edit|delete|duplicate|clone/i })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^all$/i })).toHaveCount(1);
  expect(browserErrors.errors, "unexpected browser errors on F1 setup catalogue").toEqual([]);
});

test("ACC setup catalogue supports filters and pagination and classifies provider rows read-only", async ({ page }) => {
  const game = SEEDED_GAME_CASES.find(({ gameId }) => gameId === "acc");
  if (!game) throw new Error("Missing canonical ACC seeded game case");
  const browserErrors = collectBrowserErrors(page);
  const response = await page.request.get("/api/acc/setups");
  expect(response.ok(), "ACC setup catalogue API").toBe(true);
  const payload: unknown = await response.json();
  const setups = objectRows(payload);
  const firstAuthorRow = setups.find((setup) => stringValue(setup, "author"));
  const firstAuthor = firstAuthorRow ? stringValue(firstAuthorRow, "author") : undefined;

  await page.goto(`/${game.prefix}/setups`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible({ timeout: 15_000 });
  await assertPaginationAndFilters(page, firstAuthor);

  // ACC catalogue rows come from provider files; no owner CRUD or browser file picker exists here.
  await expect(page.getByRole("button", { name: /new tune|import|edit|delete|duplicate|clone/i })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^all$/i })).toHaveCount(1);
  await page.goto("/acc/setups/import", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/could not find your acc setups folder/i)).toBeVisible({ timeout: 10_000 });
  expect(browserErrors.errors, "unexpected browser errors on ACC setup catalogue").toEqual([]);
});

test("setup manager opens conflict choices when backup already exists", async ({ page }) => {
  await mockSetupManagerApis(page);
  await page.goto("/acc/setup-manager", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "Back up", exact: true }).click();

  await expect(page.getByRole("dialog", { name: "A setup with this name already exists" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save copy", exact: true })).toBeVisible();
});

test("setup manager exposes its active Updated sort", async ({ page }) => {
  await mockSetupManagerApis(page);
  await page.goto("/acc/setup-manager", { waitUntil: "domcontentloaded" });

  const drivePanel = page.getByRole("heading", { name: "Google Drive" }).locator("..").locator("..");
  const sort = drivePanel.getByRole("combobox");
  await expect(sort).toHaveValue("updated");
  await expect(sort.locator('option[value="updated"]')).toHaveText("Updated");
});

test("setup manager panel header separates title and sort control", async ({ page }) => {
  await mockSetupManagerApis(page);
  await page.goto("/acc/setup-manager", { waitUntil: "domcontentloaded" });

  const panelHeader = page.getByRole("heading", { name: "Google Drive" }).locator("..");
  await expect(panelHeader).toHaveCSS("justify-content", "space-between");
});
test("setup manager visual baseline stays stable", async ({ page }) => {
  await mockSetupManagerApis(page);
  await page.goto("/acc/setup-manager", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Google Drive" })).toBeVisible();

  await expect(page).toHaveScreenshot("setup-manager-default.png", {
    animations: "disabled",
    fullPage: true,
  });
});
