import { expect, type Page, test } from "@playwright/test";

const SCREENSHOT_DIR = process.env.RACEIQ_SCREENSHOT_DIR ?? "./screenshots/app";
test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop/lmu-${name}.png`, fullPage: true, animations: "disabled" });
}

async function openSetup(page: Page) {
  await page.goto("/lmu/setups", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^baseline\.svm/ }).click();
  await expect(page.getByRole("region", { name: "Active setup", exact: true })).toBeVisible();
}

test("LMU setup pages, pending edits, save and switch dialogs", async ({ page }) => {
  await openSetup(page);
  const tabs = page.getByRole("tab");
  const names = await tabs.allTextContents();
  for (const [index, name] of names.entries()) {
    await tabs.nth(index).click();
    await expect(tabs.nth(index)).toHaveAttribute("aria-selected", "true");
    await capture(page, `setup-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  }
  await tabs.first().click();
  await page.getByRole("button", { name: /Increase.*GENERAL\.FuelSetting/ }).click();
  await expect(page.getByRole("region", { name: "Pending click preview" })).toBeVisible();
  await capture(page, "pending-edits");
  await page.getByRole("button", { name: /Save.*Download/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture(page, "save-dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^comparison\.svm/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture(page, "discard-dialog");
});

test("LMU setup comparison and import dialog", async ({ page }) => {
  await page.goto("/lmu/setups", { waitUntil: "networkidle" });
  await page.getByRole("checkbox", { name: "baseline.svm", exact: true }).check();
  await page.getByRole("checkbox", { name: "comparison.svm", exact: true }).check();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("REARWING.RWSetting", { exact: true })).toBeVisible();
  await capture(page, "comparison");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await capture(page, "import-dialog");
});

for (const view of ["Parameters", "Symptoms"] as const) {
  test(`LMU ${view.toLowerCase()} guides reduced motion`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/lmu/setups/guides", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: view, exact: true }).click();
    const navigation = page.locator("nav").filter({ has: page.locator('button[aria-current="page"]') });
    const topics = navigation.getByRole("button");
    const count = await topics.count();
    for (let index = 0; index < count; index++) {
      await topics.nth(index).click();
      await expect(topics.nth(index)).toHaveAttribute("aria-current", "page");
      const illustration = page.locator("[data-guide-illustration]").first();
      await expect(illustration).toBeVisible();
      const id = (await illustration.getAttribute("data-guide-illustration"))!.replace(":", "-");
      await capture(page, `guide-${id}-reduced`);
    }
  });
}

test("LMU guide explicitly paused", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/lmu/setups/guides?parameter=rideHeight", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".lmu-guide-illustration")).toHaveAttribute("data-paused", "true");
  await capture(page, "guide-ride-height-paused");
});

test("LMU experiment creation and saved setup detail", async ({ page, request }) => {
  await page.goto("/lmu/experiments", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "+ New experiment", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "New experiment" })).toBeVisible();
  await capture(page, "experiment-create");
  await page.keyboard.press("Escape");
  const listing = await request.get("/api/lmu/setups");
  expect(listing.ok()).toBe(true);
  const { files } = await listing.json();
  const base = files.find((file: { fileName: string }) => file.fileName === "baseline.svm");
  expect(base).toBeDefined();
  const created = await request.post("/api/experiments", {
    data: { gameId: "lmu", name: "LMU setup experiment", carName: base.carName, trackName: base.trackName, baseSetupPath: base.path, focus: "car" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  try {
    await page.goto(`/lmu/experiments/${id}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /LMU setup experiment/ })).toBeVisible();
    await capture(page, "experiment-detail");
  } finally {
    const archived = await request.patch(`/api/experiments/${id}`, { data: { status: "archived" } });
    expect(archived.ok()).toBe(true);
  }
});
