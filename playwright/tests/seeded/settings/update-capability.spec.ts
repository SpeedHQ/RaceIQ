import { expect, test } from "@playwright/test";

test.skip(process.env.DEV_FORCE_UPDATE !== "1" || process.platform === "win32" || process.env.RACEIQ_DISABLE_IN_APP_UPDATE === "1", "Requires an unmanaged non-Windows server launched with DEV_FORCE_UPDATE=1.");

test("external update capability exposes release link in Settings and modal without applying installer", async ({ page, request }) => {
  let applyRequests = 0;
  page.on("request", (browserRequest) => {
    if (browserRequest.url().includes("/api/update/apply")) applyRequests++;
  });

  const updateCheck = await request.post("/api/update/check");
  expect(updateCheck.ok()).toBe(true);
  const versionResponse = await request.get("/api/version");
  expect(versionResponse.ok()).toBe(true);
  expect(await versionResponse.json()).toMatchObject({
    updatesDisabled: true,
    externalUpdateUrl: "https://github.com/SpeedHQ/RaceIQ/releases/latest",
    downloadUrl: null,
    updateAvailable: true,
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Updates" }).click();
  const externalLink = page.getByRole("link", { name: "Download the latest release and follow its installation instructions." });
  await expect(externalLink).toHaveAttribute("href", "https://github.com/SpeedHQ/RaceIQ/releases/latest");
  await expect(page.getByRole("button", { name: "Install update" })).toHaveCount(0);

  await page.goto("/?update", { waitUntil: "domcontentloaded" });
  await expect(externalLink).toHaveAttribute("href", "https://github.com/SpeedHQ/RaceIQ/releases/latest");
  await expect(page.getByRole("button", { name: "Install update" })).toHaveCount(0);
  expect(applyRequests).toBe(0);
});
