import { test, expect } from "@playwright/test";

// Mobile responsive screenshot tests.
//
// Runs against the fresh-install webServer (compiled binary with isolated
// DATA_DIR, seeded with udpPort only). This spec PUTs onboardingComplete=true
// before the first navigation so the wizard doesn't block every page.
//
// Pages that are designed for big screens (live telemetry, compare, analyse)
// are deliberately excluded — the purpose is to verify that the *non-deferred*
// pages render correctly at narrow viewports.
//
// Output: playwright/screenshots/mobile/<viewport>/<page>.png (gitignored).

const SCREENSHOT_DIR = "./screenshots/mobile";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },       // iPhone 14
  { name: "tablet", width: 768, height: 1024 },      // iPad portrait
  { name: "desktop", width: 1280, height: 800 },     // small laptop — baseline
] as const;

const PAGES = [
  { name: "home", path: "/" },
  { name: "fm23-landing", path: "/fm23" },
  { name: "fm23-sessions", path: "/fm23/sessions" },
  { name: "fm23-cars", path: "/fm23/cars" },
  { name: "fm23-tracks", path: "/fm23/tracks" },
  { name: "fm23-chats", path: "/fm23/chats" },
  { name: "f125-cars", path: "/f125/cars" },
  { name: "f125-tracks", path: "/f125/tracks" },
] as const;

test.beforeAll(async ({ request }) => {
  // Fresh-install server boots with onboardingComplete=false, which makes
  // every page render the wizard. Flip it so the app chrome is reachable.
  const res = await request.put("/api/settings", {
    data: { onboardingComplete: true, driverName: "TestDriver" },
  });
  expect(res.ok()).toBeTruthy();
});

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const page of PAGES) {
      test(page.name, async ({ page: p }) => {
        await p.goto(page.path, { waitUntil: "networkidle" });
        await p.waitForTimeout(500);
        await p.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.name}/${page.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      });
    }

    // Mobile-only: verify the hamburger drawer opens and shows nav tabs.
    if (viewport.width < 768) {
      test("nav-drawer-open", async ({ page: p }) => {
        await p.goto("/fm23", { waitUntil: "networkidle" });
        await p.getByLabel("Open navigation").click();
        // Wait for drawer heading to appear
        await expect(p.getByText("Navigation", { exact: true })).toBeVisible();
        await p.waitForTimeout(200);
        await p.screenshot({
          path: `${SCREENSHOT_DIR}/${viewport.name}/nav-drawer-open.png`,
          fullPage: false,
          animations: "disabled",
        });
      });
    }

    test("settings-modal", async ({ page: p }) => {
      await p.goto("/", { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Settings" }).click();
      await expect(p.getByRole("heading", { name: "Settings" })).toBeVisible();
      await p.waitForTimeout(200);
      await p.screenshot({
        path: `${SCREENSHOT_DIR}/${viewport.name}/settings-modal.png`,
        fullPage: false,
        animations: "disabled",
      });
    });
  });
}
