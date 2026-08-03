import { expect, test, type Page } from "@playwright/test";

import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import { collectBrowserErrors } from "./seeded-e2e-helpers";
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
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    if ((await options.count()) > 1) {
      await options.nth(1).click();
      await expect(filter).not.toHaveValue("");
      await filter.click();
      await options.first().click();
    } else {
      await page.keyboard.press("Escape");
    }
  }
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
