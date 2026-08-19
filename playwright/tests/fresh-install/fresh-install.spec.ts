import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectBrowserErrors } from "../support/browser-errors";

const SETTINGS_PATH = resolve(__dirname, "..", "..", "test-data", "settings.json");

// Reset settings.json to the same seed start-server.ts writes at boot, so the
// wizard test is idempotent across retries (server re-reads settings on every
// GET /api/settings, so a file reset is enough — no server restart needed).
function resetSettingsFile() {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 15318 }));
}
const GAME_ROUTE_PREFIXES = ["fm23", "f125", "acc", "ac-evo"] as const;

// Waits for every <img> on the current page to finish loading
// (naturalWidth > 0). Vacuously passes when the page has no images.
async function assertImagesLoaded(page: Page) {
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0), undefined, { timeout: 15_000 });
  const broken = await page.evaluate(() =>
    Array.from(document.images)
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.src),
  );
  expect(broken, `broken images:\n${broken.join("\n")}`).toEqual([]);
}

// Serial: wizard runs first and flips server-side onboardingComplete=true,
// so later tests can navigate straight to game routes without the modal.
// The compiled binary starts a WebGL demo on the welcome step. On the
// 2-vCPU CI runner that startup can consume the default 30-second test budget
// before the wizard reaches its final step.
test.describe
  .serial("fresh install", () => {
    test.setTimeout(120_000);
    test("user steps through wizard and lands on home page", async ({ page }) => {
      resetSettingsFile();
      const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);

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

      // Step 6: Startup (Launch on Login)
      await expect(page.getByRole("heading", { name: "Launch on Login" })).toBeVisible();
      await page.getByRole("button", { name: "Next" }).click();

      // Step 7: Community — final. Button reads "Next" when not receiving telemetry; clicking it finishes.
      await expect(page.getByRole("heading", { name: "You're all set!" })).toBeVisible();
      const saveSettings = page.waitForResponse((response) => {
        if (response.request().method() !== "PUT" || !response.url().endsWith("/api/settings")) return false;
        const body = response.request().postDataJSON() as { onboardingComplete?: boolean } | null;
        return body?.onboardingComplete === true;
      });
      await page.getByRole("button", { name: "Next" }).click();
      expect((await saveSettings).ok(), "onboarding settings save").toBe(true);

      // Onboarding modal closes after settings mutation invalidates cached settings.
      await expect(page.getByRole("heading", { name: "You're all set!" })).toBeHidden({ timeout: 15_000 });
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
        const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);
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

    test("sidebar navigation selects games and persists collapse", async ({ page }) => {
      const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });

      const navigation = page.getByRole("navigation", { name: "Navigation" });
      await expect(navigation).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Games" })).toHaveText("Forza Motorsport 2023");
      for (const name of ["Live", "Sessions", "Compare", "Analyse", "Driver", "Chats", "Tracks", "Cars", "Setups", "Raw"]) {
        await expect(navigation.getByRole("link", { name })).toBeVisible();
      }
      await expect(navigation.getByRole("link", { name: "Experiments" })).toHaveCount(0);
      await expect(navigation.getByRole("button", { name: /Settings \(TestDriver\)/ })).toBeVisible();
      await expect(navigation.getByRole("status")).toBeVisible();

      await expect(navigation).toHaveAttribute("data-collapsed", "false");
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(navigation).toHaveAttribute("data-collapsed", "true");

      await navigation.getByRole("link", { name: "Sessions" }).hover();
      await expect(page.getByRole("tooltip", { name: "Sessions" })).toBeVisible();

      const gameSelect = page.getByRole("combobox", { name: "Games" });
      await gameSelect.hover();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.getByRole("option", { name: "F1 2025" }).click();
      await expect(page).toHaveURL(/\/f125$/);
      await expect(navigation.getByRole("link", { name: "Experiments" })).toBeVisible();

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(navigation).toHaveAttribute("data-collapsed", "true");
      await assertImagesLoaded(page);
      expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
    });

    test("mobile navigation drawer shares expanded sidebar controls", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/fm23/sessions", { waitUntil: "domcontentloaded" });
      await page.getByLabel("Open navigation").click();

      const navigation = page.getByRole("navigation", { name: "Navigation" });
      await expect(navigation).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Games" })).toBeVisible();
      await expect(navigation.getByRole("link", { name: "Sessions" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Collapse sidebar|Expand sidebar/ })).toHaveCount(0);

      await navigation.getByRole("link", { name: "Tracks" }).click();
      await expect(page.getByLabel("Open navigation")).toBeVisible();
    });

    test("dash catalogue lists dashboards", async ({ page }) => {
      const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);
      await page.goto("/dash", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
      await expect(page.getByText(/Combo Dash 1/)).toBeVisible();
      await expect(page.getByText(/Combo Dash 2/)).toBeVisible();
      await assertImagesLoaded(page);
      expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
    });

    test("settings modal opens without error", async ({ page }) => {
      const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Hello, TestDriver" })).toBeVisible();
      await page.getByRole("button", { name: /TestDriver/ }).click();
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await assertImagesLoaded(page);
      expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
    });
  });
