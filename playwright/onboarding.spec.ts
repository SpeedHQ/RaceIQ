import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

const SETTINGS_PATH = resolve(__dirname, "test-data", "settings.json");

test.describe("onboarding wizard", () => {
  test("user steps through wizard and lands on home page", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Step 1: Welcome
    await expect(page.getByRole("heading", { name: "RaceIQ", level: 2 })).toBeVisible({ timeout: 15_000 });
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
  });
});
