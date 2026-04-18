import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SETTINGS_PATH = resolve(__dirname, "test-data", "settings.json");
const GAME_ROUTE_PREFIXES = ["fm23", "f125", "acc", "ac-evo"] as const;

// Known benign noise: three's GLTFLoader logs texture-load failures for the
// demo CarWireframe's blob-embedded textures — mesh still renders.
const IGNORE = [
  /THREE\.GLTFLoader: Couldn't load texture/,
];

// Waits for every <img> on the current page to finish loading
// (naturalWidth > 0). Vacuously passes when the page has no images.
async function assertImagesLoaded(page: Page) {
  await page.waitForFunction(
    () => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
    undefined,
    { timeout: 15_000 },
  );
  const broken = await page.evaluate(() =>
    Array.from(document.images)
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.src)
  );
  expect(broken, `broken images:\n${broken.join("\n")}`).toEqual([]);
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  const record = (s: string) => {
    if (!IGNORE.some((rx) => rx.test(s))) errors.push(s);
  };
  page.on("pageerror", (err) => record(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") record(`console.error: ${msg.text()}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) record(`http ${res.status()}: ${res.url()}`);
  });
  return errors;
}

// Serial: wizard runs first and flips server-side onboardingComplete=true,
// so later tests can navigate straight to game routes without the modal.
test.describe.serial("fresh install", () => {
  test("user steps through wizard and lands on home page", async ({ page }) => {
    const errors = collectErrors(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Step 1: Welcome — demo 3D render (R3F canvas) should mount from demo-lap.csv
    await expect(page.getByRole("heading", { name: "RaceIQ", level: 2 })).toBeVisible({ timeout: 15_000 });
    const demoCanvas = page.locator("canvas").first();
    await expect(demoCanvas).toBeVisible({ timeout: 15_000 });
    const canvasBox = await demoCanvas.boundingBox();
    expect(canvasBox?.width ?? 0).toBeGreaterThan(0);
    expect(canvasBox?.height ?? 0).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Get Started" }).click();

    // Step 2: Profile
    await expect(page.getByRole("heading", { name: "What's your name?" })).toBeVisible();
    await page.getByLabel("Driver name").fill("TestDriver");
    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: Wheel
    await expect(page.getByText(/Choose the steering wheel/i)).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 4: Units
    await expect(page.getByRole("heading", { name: "Units" })).toBeVisible();
    await page.getByRole("button", { name: /^Metric/ }).click();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 5: Sound
    await expect(page.getByRole("heading", { name: "Sound" })).toBeVisible();
    await page.getByRole("button", { name: "Off" }).click();
    await page.getByRole("button", { name: "Next" }).click();

    // Step 6: Community — final. Button reads "Next" when not receiving telemetry; clicking it finishes.
    await expect(page.getByRole("heading", { name: "You're all set!" })).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    // Onboarding modal gone, home page rendered
    await expect(page.getByRole("heading", { name: "You're all set!" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hello, TestDriver" })).toBeVisible();

    // Server persisted driver name + onboardingComplete to settings.json
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(settings.driverName).toBe("TestDriver");
    expect(settings.onboardingComplete).toBe(true);

    await assertImagesLoaded(page);
    expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });

  for (const prefix of GAME_ROUTE_PREFIXES) {
    test(`${prefix} tracks page lists tracks`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(`/${prefix}/tracks`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: "Tracks" })).toBeVisible();

      // TrackViewer shows a summary "N with outlines, M without". Wait for it,
      // then assert total tracks > 0.
      const summary = page.getByText(/\d+ with outlines, \d+ without/);
      await expect(summary).toBeVisible({ timeout: 10_000 });
      const match = (await summary.textContent())?.match(/(\d+) with outlines, (\d+) without/);
      const withOutlines = Number(match?.[1] ?? 0);
      const withoutOutlines = Number(match?.[2] ?? 0);
      expect(withOutlines + withoutOutlines, `${prefix} has no tracks`).toBeGreaterThan(0);

      await assertImagesLoaded(page);
      expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
    });
  }

  test("dash catalogue lists dashboards", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/dash", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
    await expect(page.getByText(/Combo Dash 1/)).toBeVisible();
    await expect(page.getByText(/Combo Dash 2/)).toBeVisible();
    await assertImagesLoaded(page);
    expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("settings modal opens without error", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Hello, TestDriver" })).toBeVisible();
    await page.getByRole("button", { name: /TestDriver/ }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await assertImagesLoaded(page);
    expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
