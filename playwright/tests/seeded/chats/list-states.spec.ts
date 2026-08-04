import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { seededChats } from "./helpers";

test("Chats route covers every seeded game and true empty state", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);

  for (const game of SEEDED_GAME_CASES) {
    const chats = await seededChats(request, game.gameId);
    await page.goto(`/${game.prefix}/chats`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Chat Sessions", exact: true })).toBeVisible();
    if (chats.length === 0) {
      await expect(page.getByText("No chat sessions yet", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText(`(${chats.length})`, { exact: true })).toBeVisible();
    }
  }

  expect(browserErrors.errors, "unexpected browser errors during game chat routes").toEqual([]);
});

test("Chats shows loading and error states from production list route", async ({ page }) => {
  test.setTimeout(120_000);
  let releaseLoading: (() => void) | undefined;
  const loadingReleased = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await page.route("**/api/chats?gameId=iracing", async (route) => {
    await loadingReleased;
    await route.continue();
  });
  await page.goto("/iracing/chats", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
  releaseLoading?.();
  await expect(page.getByText("No chat sessions yet", { exact: true })).toBeVisible();
  await page.unroute("**/api/chats?gameId=iracing");

  await page.route("**/api/chats?gameId=iracing", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "seeded fault" }) }));
  await page.goto("/iracing/chats", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("HTTP 500", { exact: true })).toBeVisible();
  await page.unroute("**/api/chats?gameId=iracing");
});
