import { expect, test } from "@playwright/test";
import { z } from "zod";

import { collectBrowserErrors } from "./seeded-e2e-helpers";

const FM_RECORDING = "fm-2023-2026-04-09T21-55-03-186Z";

const ReplayResponseSchema = z.object({
  ok: z.literal(true),
  recordingName: z.string(),
  replayedPacketCount: z.number().int().positive(),
});

const DASH_FAMILIES = [
  { slug: "combo-1", name: "Race HUD", path: "/dash/combo-1", linkText: /KM\/H|MPH/i },
  { slug: "combo-2", name: "Lap Times & Pace", path: "/dash/combo-2", linkText: /Recorded Laps/i },
] as const;

test.describe.configure({ mode: "serial" });

async function assertReplayCompleted(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  expect(response.ok(), "replay response ok").toBe(true);
  const payload = ReplayResponseSchema.parse(await response.json());
  expect(payload.replayedPacketCount, `replayed packets for ${payload.recordingName}`).toBeGreaterThan(1);
  expect(payload.replayedPacketCount, `max packets used by ${payload.recordingName}`).toBeLessThanOrEqual(240);
}

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const root = document.documentElement;
          const workspace = document.querySelector<HTMLElement>("[data-responsive-workspace]");
          return root.scrollWidth <= root.clientWidth + 1 && workspace !== null && workspace.scrollWidth <= workspace.clientWidth + 1;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}

for (const family of DASH_FAMILIES) {
  test(`dash catalogue opens ${family.name} and validates route`, async ({ page }) => {
    const browserErrors = collectBrowserErrors(page);

    await page.goto("/dash", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL("/dash");
    await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();

    const cardLink = page.getByRole("link", { name: family.name });
    await expect(cardLink).toBeVisible();
    await expect(cardLink).toHaveAttribute("href", family.path);

    await Promise.all([
      page.waitForURL(new RegExp(`${family.path.replaceAll("/", "\\/")}$`)),
      cardLink.click(),
    ]);

    await expect(page.getByRole("heading", { name: /"?Dashboards"?/ })).not.toBeVisible({ timeout: 1_000 }).catch(() => void 0);
    const familyMarker = page.getByText(family.linkText);
    await expect(familyMarker).toBeVisible({ timeout: 20_000 });

    if (family.slug === "combo-1") {
      await expect(page.getByText("KM/H")).not.toHaveCount(0);
    } else {
      await expect(page.getByRole("heading", { name: /Recorded Laps/ })).toBeVisible();
    }

    await page.goto("/dash");
    await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
    expect(browserErrors.errors, `unexpected browser errors for ${family.name}`).toEqual([]);
  });
}

test("dash layout selection persists across reload via route state", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/dash", { waitUntil: "domcontentloaded" });
  const combo2Link = page.getByRole("link", { name: "Lap Times & Pace" });
  await Promise.all([page.waitForURL("/dash/combo-2"), combo2Link.click()]);

  await expect(page.getByRole("heading", { name: /Recorded Laps/ })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL("/dash/combo-2");
  await expect(page.getByRole("heading", { name: /Recorded Laps/ })).toBeVisible();

  await page.goto("/dash/combo-1", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/KM\/H|MPH/)).toBeVisible();
  expect(browserErrors.errors, "unexpected browser errors in dash layout persistence flow").toEqual([]);
});

test("dash/fm-2023 replay binds combo-1 values and combo-2 track flow", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);

  const combo1Replay = request.post(`/api/dev/replay/${FM_RECORDING}?packets=240&intervalMs=12`);
  await page.goto("/dash/combo-1", { waitUntil: "domcontentloaded" });

  const speedTile = page.getByText(/KM\/H|MPH/, { exact: false }).locator("..");
  const observedValues = new Set<string>();
  await expect
    .poll(
      async () => {
        const value = (await speedTile.innerText()).trim();
        if (value) observedValues.add(value);
        return observedValues.size;
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBeGreaterThan(1);

  await assertReplayCompleted(combo1Replay);
  await expect(page.getByText("Waiting for lap data…", { exact: true })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Waiting for tire data…", { exact: true })).toHaveCount(0, { timeout: 20_000 });

  const combo2Replay = request.post(`/api/dev/replay/${FM_RECORDING}?packets=120&intervalMs=12`);
  await page.goto("/dash/combo-2", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Waiting for track…", { exact: true })).toHaveCount(0, { timeout: 20_000 });

  const recordedPanel = page
    .getByRole("heading", { name: /Recorded Laps/ })
    .locator("../..")
    .locator("div.grid.gap-x-2.px-3.py-1\\.5.items-center");
  await expect
    .poll(() => recordedPanel.count(), { timeout: 20_000, intervals: [100, 150, 200, 300] })
    .toBeGreaterThan(0);

  await assertReplayCompleted(combo2Replay);
  expect(browserErrors.errors, "unexpected browser errors in dash replay flow").toEqual([]);
});

test("dash responsive accessibility and no overflow on catalogue and combo routes", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const viewports = [
    { width: 360, height: 780 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ];
  const routes = ["/dash", "/dash/combo-1", "/dash/combo-2"];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);

    for (const path of routes) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-responsive-workspace]")).toHaveCount(1);
      await expect(page.locator("[data-responsive-workspace]")).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await expect(page.getByText(/Desktop required/i)).toHaveCount(0);
      await expect(page.getByText(/Rotate your device/i)).toHaveCount(0);

      if (path === "/dash") {
        await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Race HUD" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Lap Times & Pace" })).toBeVisible();
      }

      if (path === "/dash/combo-1") {
        await expect(page.getByText(/KM\/H|MPH/)).toBeVisible({ timeout: 20_000 });
      }

      if (path === "/dash/combo-2") {
        await expect(page.getByRole("heading", { name: /Recorded Laps/ })).toBeVisible({ timeout: 20_000 });
      }
    }
  }

  expect(browserErrors.errors, "unexpected browser errors in dash responsive accessibility flow").toEqual([]);
});
