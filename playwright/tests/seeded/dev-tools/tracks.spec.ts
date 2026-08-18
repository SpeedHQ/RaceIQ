import { expect, test, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../../support/responsive/assertions";
import { collectBrowserErrors } from "../../support/browser-errors";
import { SEEDED_GAME_CASES, type SeededGame } from "../../support/seeded/cases";

const FM_TRACK = SEEDED_GAME_CASES.find((game) => game.gameId === "fm-2023")!;
const F1_TRACK = SEEDED_GAME_CASES.find((game) => game.gameId === "f1-2025")!;
const IRACING_TRACK = SEEDED_GAME_CASES.find((game) => game.gameId === "iracing")!;

function selectedTrackPath(game: SeededGame, tool = "") {
  return `/dev/tracks/${game.gameId}/${game.trackOrdinal}${tool ? `/${tool}` : ""}`;
}

async function selectTrack(page: Page, game: SeededGame) {
  await page.goto("/dev/tracks", { waitUntil: "domcontentloaded" });
  const filter = page.getByPlaceholder("Filter track, venue, game, or ordinal…");
  await expect(filter).toBeVisible({ timeout: 20_000 });
  await filter.fill(game.gameId);

  const row = page
    .locator("details")
    .filter({ has: page.getByText(game.gameId, { exact: true }) })
    .filter({ hasText: `#${game.trackOrdinal}` })
    .last();
  await expect(row).toBeVisible();
  await row.locator("summary").first().click();
  await row.getByRole("button", { name: /Open workbench/i }).click();
  await expect(page).toHaveURL(new RegExp(`/dev/tracks/${game.gameId}/${game.trackOrdinal}/?$`));
  await expect(page.getByTestId(`dev-selected-track-${game.gameId}-${game.trackOrdinal}`)).toBeVisible();
}

async function openTool(page: Page, game: SeededGame, tool: "geometry" | "guides" | "imagery") {
  await page.goto(selectedTrackPath(game, tool), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId(`dev-selected-track-${game.gameId}-${game.trackOrdinal}`)).toBeVisible();
}

test("developer Tracks action routes to neutral workbench and selection preserves identity", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Tracks", exact: true }).click();
  await expect(page).toHaveURL(/\/dev\/tracks\/?$/);
  await expect(page.getByPlaceholder("Filter track, venue, game, or ordinal…")).toBeVisible();
  await expect(page.getByTestId(`dev-selected-track-${FM_TRACK.gameId}-${FM_TRACK.trackOrdinal}`)).toHaveCount(0);

  await selectTrack(page, FM_TRACK);

  for (const tool of ["turns", "sectors", "guides", "imagery"] as const) {
    const card = page.getByTestId(`dev-track-tool-${tool}`);
    await expect(card).toBeVisible();
    const expectedPath =
      tool === "turns"
        ? selectedTrackPath(FM_TRACK, "geometry?mode=turns")
        : tool === "sectors"
          ? selectedTrackPath(FM_TRACK, "geometry?mode=sectors")
          : selectedTrackPath(FM_TRACK, tool);
    await expect(card).toHaveAttribute("href", expectedPath);
  }
  await expect(page.getByTestId("dev-geometry-mode-turns")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Change track/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Overview/i })).toHaveAttribute("href", new RegExp(selectedTrackPath(FM_TRACK)));
  expect(browserErrors.errors, "unexpected browser errors in Tracks workbench").toEqual([]);
});

test("developer Geometry keeps mode URL and layer state independent through history", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await selectTrack(page, FM_TRACK);
  await page.getByTestId("dev-track-tool-turns").click();
  await expect(page).toHaveURL(/\/geometry\/?\?mode=turns$/);
  await expect(page.getByTestId("dev-geometry-mode-turns")).toBeVisible();

  const segments = page.getByRole("checkbox", { name: /Segments/i });
  const sectors = page.getByRole("checkbox", { name: /Sectors/i });
  await expect(segments).toBeChecked();
  await expect(sectors).not.toBeChecked();
  await sectors.check();
  await expect(segments).toBeChecked();
  await expect(sectors).toBeChecked();
  await segments.uncheck();
  await expect(sectors).toBeChecked();

  await page.getByTestId("dev-geometry-mode-sectors").click();
  await expect(page).toHaveURL(/\/geometry\/?\?mode=sectors$/);
  await expect(page.getByTestId("dev-geometry-mode-sectors")).toBeVisible();
  await expect(segments).not.toBeChecked();
  await expect(sectors).toBeChecked();

  await page.goBack();
  await expect(page).toHaveURL(/\/geometry\/?\?mode=turns$/);
  await expect(page.getByTestId("dev-geometry-mode-turns")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/geometry\/?\?mode=sectors$/);
  await expect(page.getByTestId("dev-geometry-mode-sectors")).toBeVisible();
  expect(browserErrors.errors, "unexpected browser errors in Geometry workbench").toEqual([]);
});

test("developer Tracks exposes dedicated Guides and Imagery routes", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await selectTrack(page, F1_TRACK);

  await page.getByTestId("dev-track-tool-guides").click();
  await expect(page).toHaveURL(new RegExp(`${selectedTrackPath(F1_TRACK, "guides")}/?$`));
  await expect(page.getByTestId(`dev-selected-track-${F1_TRACK.gameId}-${F1_TRACK.trackOrdinal}`)).toBeVisible();
  await expect(page.getByText(/track guide|canonical assignment|guide/i).first()).toBeVisible();

  await page.getByRole("link", { name: /Imagery/i }).click();
  await expect(page).toHaveURL(new RegExp(`${selectedTrackPath(F1_TRACK, "imagery")}/?$`));
  await expect(page.getByTestId(`dev-selected-track-${F1_TRACK.gameId}-${F1_TRACK.trackOrdinal}`)).toBeVisible();
  await expect(page.getByText(/imagery calibration/i).first()).toBeVisible();
  expect(browserErrors.errors, "unexpected browser errors in dedicated Tracks routes").toEqual([]);
});

test("developer Guide saves unchanged document, reloads it, and rejects invalid draft", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const guideUrl = `/api/dev/track-guides/${F1_TRACK.trackOrdinal}?gameId=${F1_TRACK.gameId}`;
  const initialResponse = await request.get(guideUrl);
  expect(initialResponse.ok()).toBe(true);
  const initialEnvelope = (await initialResponse.json()) as { guide: Record<string, unknown> | null };
  expect(initialEnvelope.guide, "seeded F1 guide required for authoring coverage").not.toBeNull();

  await openTool(page, F1_TRACK, "guides");
  const saveButton = page.getByRole("button", { name: /save guide/i });
  await expect(saveButton).toBeVisible();
  const saveResponsePromise = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/dev/track-guides/${F1_TRACK.trackOrdinal}`);
  const saveRequestPromise = page.waitForRequest((requestEvent) => requestEvent.method() === "PUT" && new URL(requestEvent.url()).pathname === `/api/dev/track-guides/${F1_TRACK.trackOrdinal}`);
  await saveButton.click();
  const [saveRequest, saveResponse] = await Promise.all([saveRequestPromise, saveResponsePromise]);
  expect(saveRequest.postDataJSON()).toEqual(initialEnvelope.guide);
  expect(saveResponse.ok()).toBe(true);
  const savedEnvelope = (await saveResponse.json()) as { guide: Record<string, unknown> | null };
  expect(savedEnvelope.guide).toEqual(initialEnvelope.guide);
  await expect(page.getByText("Guide saved", { exact: true })).toBeVisible();

  const character = page.getByLabel(/character/i).first();
  await expect(character).toBeVisible();
  await expect(character).toHaveValue(String(initialEnvelope.guide!.character));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel(/character/i).first()).toHaveValue(String(initialEnvelope.guide!.character));

  let invalidPutCount = 0;
  page.on("request", (requestEvent) => {
    if (requestEvent.method() === "PUT" && new URL(requestEvent.url()).pathname === `/api/dev/track-guides/${F1_TRACK.trackOrdinal}`) invalidPutCount += 1;
  });
  await page.getByLabel(/character/i).first().fill("");
  await page.getByRole("button", { name: /save guide/i }).click();
  await expect(page.getByText(/character.*required|required.*character/i)).toBeVisible();
  expect(invalidPutCount).toBe(0);
  expect(browserErrors.errors, "unexpected browser errors in Guide editor").toEqual([]);
});

test("developer native timing sectors remain game-owned and read-only", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const boundariesUrl = `/api/track-sector-boundaries/${IRACING_TRACK.trackOrdinal}?gameId=${IRACING_TRACK.gameId}`;
  const boundariesResponse = await request.get(boundariesUrl);
  expect(boundariesResponse.ok()).toBe(true);
  const boundaries = (await boundariesResponse.json()) as { ownership?: string; editable?: boolean; sectorStarts?: number[] };
  expect(boundaries.ownership).toBe("game");
  expect(boundaries.editable).toBe(false);

  await openTool(page, IRACING_TRACK, "geometry");
  await page.getByTestId("dev-geometry-mode-sectors").click();
  await expect(page.getByText(/Game supplied.*(?:read-only|no recorded layout)/i)).toBeVisible();
  await expect(page.getByText(/no recorded layout|recorded layout|sector starts/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /save.*sector/i })).toHaveCount(0);
  await expect(page.getByRole("spinbutton")).toHaveCount(0);

  const rejected = await request.put(boundariesUrl, { data: { malformed: true } });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: "native-sectors-read-only" });
  expect(browserErrors.errors, "unexpected browser errors in native Geometry workbench").toEqual([]);
});

test("developer non-native timing sector save submits unchanged boundaries", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const boundariesUrl = `/api/track-sector-boundaries/${FM_TRACK.trackOrdinal}?gameId=${FM_TRACK.gameId}`;
  const boundariesResponse = await request.get(boundariesUrl);
  expect(boundariesResponse.ok()).toBe(true);
  const boundaries = (await boundariesResponse.json()) as { ownership?: string; editable?: boolean; s1End: number; s2End: number };
  expect(boundaries.ownership).toBe("raceiq");
  expect(boundaries.editable).toBe(true);

  await openTool(page, FM_TRACK, "geometry");
  await page.getByTestId("dev-geometry-mode-sectors").click();
  await expect(page.getByRole("button", { name: /save.*sector/i })).toBeVisible();
  const saveRequestPromise = page.waitForRequest((requestEvent) => requestEvent.method() === "PUT" && new URL(requestEvent.url()).pathname === `/api/track-sector-boundaries/${FM_TRACK.trackOrdinal}`);
  await page.getByRole("button", { name: /save.*sector/i }).click();
  const saveRequest = await saveRequestPromise;
  const payload = saveRequest.postDataJSON() as { s1End: number; s2End: number };
  expect(payload.s1End).toBeCloseTo(boundaries.s1End);
  expect(payload.s2End).toBeCloseTo(boundaries.s2End);
  expect(browserErrors.errors, "unexpected browser errors in non-native Geometry workbench").toEqual([]);
});

for (const viewport of [
  { name: "minimum", width: 320, height: 568 },
  { name: "square", width: 900, height: 900 },
  { name: "desktop", width: 1280, height: 800 },
] as const) {
  test(`developer selected Tracks tools remain reachable without overflow at ${viewport.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const tool of ["", "geometry?mode=turns", "guides", "imagery"] as const) {
      const suffix = tool === "" ? "" : `/${tool}`;
      await page.goto(`${selectedTrackPath(FM_TRACK)}${suffix}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId(`dev-selected-track-${FM_TRACK.gameId}-${FM_TRACK.trackOrdinal}`)).toBeVisible();
      await expect(page.getByText("Desktop required")).toHaveCount(0);
      await expect(page.getByText("Rotate your device")).toHaveCount(0);
      if (tool === "") await expect(page.getByRole("link", { name: /Change track/i })).toBeVisible();
      if (tool.startsWith("geometry")) await expect(page.getByTestId("dev-geometry-mode-turns")).toBeVisible();
      if (tool === "guides") await expect(page.getByRole("button", { name: /save guide/i })).toBeVisible();
      if (tool === "imagery") await expect(page.getByText(/imagery calibration/i).first()).toBeVisible();
      await assertNoHorizontalOverflow(page);
    }
  });
}
