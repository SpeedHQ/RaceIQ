import { createClient } from "@libsql/client";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { runtime } from "../../config/runtime";
import { collectBrowserErrors } from "../support/browser-errors";

const SETTINGS_PATH = resolve(runtime.freshInstall.dataDir, "settings.json");

// A retry reuses the server process, but dashboard access is persisted separately
// from settings. Reset both stores inside this isolated E2E data directory.
async function resetFreshInstallState() {
  const { dataDir } = runtime.freshInstall;
  if (!dataDir.split(/[\\/]+/).some((part) => part.includes("test-data"))) {
    throw new Error(`Refusing to reset fresh-install state outside test-data: "${dataDir}"`);
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: Number(runtime.freshInstall.udpPort) }));
  rmSync(resolve(dataDir, "app.db.dashboard-access"), { force: true });
  const database = createClient({ url: `file:${resolve(dataDir, "app.db")}` });
  try {
    const [result] = await database.batch([
      "UPDATE dashboard_access SET mode = 'pending', password_hash = NULL, revision = revision + 1 WHERE id = 1",
      "DELETE FROM dashboard_sessions",
    ], "write");
    if (Number(result.rowsAffected) !== 1) throw new Error("Fresh-install dashboard access fixture is missing");
  } finally {
    database.close();
  }
}
const GAME_ROUTE_PREFIXES = ["fm23", "f125", "acc", "ac-evo"] as const;

// Waits for every visible HTML image on the current page to finish loading.
// Three.js creates detached image loaders for model textures; those are not
// page-facing images and must not block this browser smoke assertion.
async function assertImagesLoaded(page: Page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("img"))
        .filter((img) => img.getClientRects().length > 0 && img.currentSrc)
        .every((img) => img.complete && img.naturalWidth > 0),
    undefined,
    { timeout: 15_000 },
  );
  const broken = await page.evaluate(() =>
    Array.from(document.querySelectorAll("img"))
      .filter((img) => img.getClientRects().length > 0 && img.currentSrc)
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.currentSrc),
  );
  expect(broken, `broken images:\n${broken.join("\n")}`).toEqual([]);
}

// Serial: wizard runs first and flips server-side onboardingComplete=true,
// so later tests can navigate straight to game routes without the modal.
test.describe
  .serial("fresh install", () => {
    test.setTimeout(140_000);
    test("user steps through wizard and lands on home page", async ({ page, request }) => {
      await resetFreshInstallState();
      page.setDefaultNavigationTimeout(60_000);
      const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);
      await page.goto("/", { waitUntil: "domcontentloaded" });

      // Step 1: Welcome — navigation must not depend on the optional 3D demo.
      await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Get Started" }).click();

      // Step 2: Access — require explicit password-protection choice.
      await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
      await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Continue without a password" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
      await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Enable password protection", exact: true }).click();
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
      await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Continue without a password" }).click();
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // Step 3: Profile
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
      await page.getByRole("switch", { name: "Sector blip" }).click();
      await page.getByRole("button", { name: "Next" }).click();

      // Step 6: Startup (Launch on Login)
      await expect(page.getByRole("heading", { name: "Launch on Login" })).toBeVisible();
      await page.getByRole("button", { name: "Next" }).click();

      // Step 7: Native chooser selection applies immediately without a dialog.
      await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
      const initialDirectory = await (await page.request.get("/api/storage/recording-directory")).json() as { directory: string };
      const destination = resolve(initialDirectory.directory, "raceiq");
      let releaseMoveRequest!: () => void;
      const moveRequestGate = new Promise<void>((resolve) => { releaseMoveRequest = resolve; });
      await page.route("**/api/storage/select-directory", (route) => route.fulfill({ json: { directory: destination } }));
      await page.route("**/api/storage/recording-directory", async (route) => {
        if (route.request().method() === "POST") await moveRequestGate;
        await route.continue();
      });
      try {
        await page.getByRole("button", { name: "Change folder" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Use this folder", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Next", includeHidden: true })).toBeDisabled();
        const backButtons = page.getByRole("button", { name: "Back", includeHidden: true });
        await expect(backButtons).toHaveCount(1);
        await expect(backButtons).toBeDisabled();
      } finally {
        releaseMoveRequest();
      }
      await expect.poll(async () => {
        const response = await page.request.get("/api/storage/recording-directory");
        const state = await response.json() as { state: string; directory: string };
        return state.state === "complete" && state.directory === realpathSync(destination);
      }, { timeout: 60_000 }).toBe(true);
      await page.getByRole("button", { name: "Next" }).click();

      // Step 8: Community — final. Button reads "Next" when not receiving telemetry; clicking it finishes.
      await expect(page.getByRole("heading", { name: "You're all set!" })).toBeVisible();
      const saveSettings = page.waitForResponse((response) => {
        if (response.request().method() !== "PUT" || !response.url().endsWith("/api/settings")) return false;
        const body = response.request().postDataJSON() as { onboardingComplete?: boolean } | null;
        return body?.onboardingComplete === true;
      }, { timeout: 60_000 });
      await page.getByRole("button", { name: /^(Next|Finish)$/ }).click();
      expect((await saveSettings).ok(), "onboarding settings save").toBe(true);

      // Onboarding modal closes after settings mutation invalidates cached settings.
      await expect(page.getByRole("heading", { name: "You're all set!" })).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

      // Server persisted driver name + onboardingComplete to settings.json
      await page.reload({ waitUntil: "domcontentloaded" });
      const persistedResponse = await request.get(`http://127.0.0.1:${runtime.freshInstall.port}/api/settings`);
      expect(persistedResponse.ok()).toBe(true);
      expect(await persistedResponse.json()).toMatchObject({
        recordingDirectory: realpathSync(destination),
        resolvedRecordingDirectory: realpathSync(destination),
        driverName: "TestDriver",
        onboardingComplete: true,
      });

      await assertImagesLoaded(page);
      rmSync(destination, { recursive: true, force: true });
      expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
    });

    test("replaying the wizard keeps the default recording folder", async ({ page }) => {
      await resetFreshInstallState();
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Get Started" }).click();
      await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Continue without a password" }).click();
      await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      for (const heading of ["What's your name?", "Choose the steering wheel displayed during live telemetry.", "Units", "Sound", "Launch on Login"]) {
        await expect(page.getByRole("heading", { name: heading })).toBeVisible();
        await page.getByRole("button", { name: "Next" }).click();
      }
      await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
      const storageResponse = await page.request.get("/api/storage/recording-directory");
      const storage = await storageResponse.json() as { directory: string };
      expect(storage.directory.replaceAll("\\", "/")).toMatch(/\/sessions$/);
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByRole("heading", { name: "You're all set!" })).toBeVisible();
      const saveSettings = page.waitForResponse((response) =>
        response.request().method() === "PUT" && response.url().endsWith("/api/settings")
        && (response.request().postDataJSON() as { onboardingComplete?: boolean } | null)?.onboardingComplete === true);
      await page.getByRole("button", { name: "Next" }).click();
      expect((await saveSettings).ok()).toBe(true);
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
      expect(settings.recordingDirectory ?? null).toBeNull();
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
    for (const name of ["Dashboard", "Sessions", "Compare", "Driver", "Chats", "Tracks", "Cars", "Setups", "Raw"]) {
      await expect(navigation.getByRole("link", { name })).toBeVisible();
    }
    await expect(navigation.getByRole("link", { name: "Experiments" })).toHaveCount(0);
    await expect(navigation.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
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
    await expect(page).toHaveURL(/\/f125\/sessions$/);
    await expect(navigation.getByRole("link", { name: "Experiments" })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(navigation).toHaveAttribute("data-collapsed", "true");
    await assertImagesLoaded(page);
    expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });


  test("dash catalogue lists dashboards", async ({ page }) => {
    const { errors } = collectBrowserErrors(page, [/THREE\.GLTFLoader: Couldn't load texture/]);
    await page.goto("/portable", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Dashboards" })).toBeVisible();
    await expect(page.getByText(/Combo Dash 1/)).toBeVisible();
    await expect(page.getByText(/Combo Dash 2/)).toBeVisible();
    await assertImagesLoaded(page);
    expect(errors, `unexpected browser errors:\n${errors.join("\n")}`).toEqual([]);
  });


  test("dashboard passwords support login, logout, change, disable and authenticated WebSockets", async ({ page, browser, baseURL }) => {
    await page.goto("/");
    async function openAccess() {
      await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "Settings" }).click();
      await page.getByRole("button", { name: "Access & security", exact: true }).click();
    }
    await openAccess();
    await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Enable password protection", exact: true }).click();
    const passwordForm = page.locator("form").filter({ has: page.getByLabel("Password", { exact: true }) });
    const formBounds = await passwordForm.boundingBox();
    const dialogBounds = await page.locator('[class~="@container/settings"]').boundingBox();
    expect(formBounds!.width).toBeLessThan(dialogBounds!.width * 0.75);
    await page.getByLabel("Password", { exact: true }).fill("abcdefg");
    await page.getByLabel("Confirm password", { exact: true }).fill("different");
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    await expect(passwordForm.getByRole("button", { name: "Enable password protection", exact: true }).and(passwordForm.locator('[type="submit"]'))).toBeDisabled();
    await page.getByLabel("Password", { exact: true }).fill("abcdefgh");
    await page.getByLabel("Confirm password", { exact: true }).fill("abcdefgh");
    await page.getByRole("button", { name: "Show password", exact: true }).first().click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
    await passwordForm.getByRole("button", { name: "Enable password protection", exact: true }).and(passwordForm.locator('[type="submit"]')).click();
    await expect(page.getByText("Password protection is enabled on every dashboard address.")).toBeVisible();
    await expect(page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Change password", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Disable password protection", exact: true })).toBeVisible();
    await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Save password settings" })).toBeDisabled();
    await page.reload();
    expect((await page.request.get("/api/status")).status()).toBe(200);
    expect((await page.request.put("/api/settings", { data: { driverName: "CSRF must fail" } })).status()).toBe(403);
    const opened = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
          socket.onopen = () => {
            socket.close();
            resolve(true);
          };
          socket.onerror = () => resolve(false);
        }),
    );
    expect(opened).toBe(true);
    const visitor = await browser.newContext({ baseURL });
    try {
      expect((await visitor.request.get("/api/status")).status()).toBe(401);
      const guest = await visitor.newPage();
      await guest.goto("/fm23/tracks?auth-return=1");
      await expect(guest.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await expect(guest.getByText("Continue without a password")).toHaveCount(0);
      await expect(guest).toHaveURL(/\/login\?redirect=/);
      await expect(guest.getByRole("button", { name: "Get Started", exact: true })).toHaveCount(0);
      await guest.getByLabel("Password", { exact: true }).fill("abcdefgh");
      await guest.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(guest).toHaveURL(/\/fm23\/tracks\?auth-return=1$/);
      expect((await visitor.request.get("/api/status")).status()).toBe(200);
    } finally {
      await visitor.close();
    }
    await openAccess();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
    const staleStatusRelease = Promise.withResolvers<void>();
    const staleStatusStarted = Promise.withResolvers<void>();
    const staleStatusDelivered = Promise.withResolvers<void>();
    let holdNextStatus = true;
    await page.route("**/api/auth/status", async (route) => {
      if (!holdNextStatus) {
        await route.continue();
        return;
      }
      holdNextStatus = false;
      const response = await route.fetch();
      staleStatusStarted.resolve();
      await staleStatusRelease.promise;
      await route.fulfill({ response });
      staleStatusDelivered.resolve();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("raceiq-auth-required")));
    await staleStatusStarted.promise;
    await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Change password", exact: true }).click();
    await page.getByLabel("Current password", { exact: true }).fill("abcdefgh");
    await page.getByLabel("New password", { exact: true }).fill("ijklmnop");
    await page.getByLabel("Confirm new password", { exact: true }).fill("ijklmnop");
    const changed = page.waitForResponse((response) => response.url().endsWith("/api/auth/password") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save password settings" }).click();
    expect((await changed).ok()).toBe(true);
    await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
    staleStatusRelease.resolve();
    await staleStatusDelivered.promise;
    await page.unroute("**/api/auth/status");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await page.getByLabel("Password", { exact: true }).fill("abcdefgh");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("The password is incorrect.")).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("ijklmnop");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await openAccess();
    await page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Change password", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("group", { name: "Password protection", exact: true }).getByRole("button", { name: "Disable password protection", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Save password settings" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm settings", exact: true })).toBeDisabled();
    await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
    await page.getByLabel("Current password", { exact: true }).fill("ijklmnop");
    await page.getByRole("button", { name: "Confirm settings", exact: true }).click();
    await expect(page.getByText("Password protection is disabled.")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });

  test("dashboard sharing shows active LAN links and copies them without credentials", async ({ page }) => {
    async function openAccess() {
      await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "Settings" }).click();
      await page.getByRole("button", { name: "Access & security", exact: true }).click();
    }
    await page.goto("/");
    await openAccess();
    await expect(page.getByText("Open on another device", { exact: true })).toHaveCount(0);

    // Model network bindings without exposing a real listener or changing
    // the user's network configuration. The preceding test disabled auth.
    let protectedAccess = false;
    let activeHosts = ["127.0.0.1", "192.0.2.15", "100.64.0.2"];
    await page.route("**/api/auth/status", async (route) => {
      const response = await route.fetch();
      const status = await response.json();
      await route.fulfill({
        response,
        json: {
          ...status,
          protected: protectedAccess,
          interfaces: [
            { name: "Active LAN", address: "192.0.2.15", tailnet: false },
            { name: "Inactive LAN", address: "192.0.2.16", tailnet: false },
            { name: "Tailscale", address: "100.64.0.2", tailnet: true },
          ],
          activeHosts,
          network: { hosts: ["127.0.0.1", "192.0.2.15", "100.64.0.2"], origins: [] },
        },
      });
    });
    await page.reload();
    await openAccess();
    const port = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="raceiq-dashboard-port"]')?.content);
    if (process.env.E2E_SERVER_MODE === "dev") {
      expect(port).toBe(new URL(page.url()).port);
      const dashboard = await page.request.get(`http://localhost:${port}/`);
      expect(dashboard.headers()["content-type"]).toContain("text/html");
      expect(await dashboard.text()).toContain('<div id="root">');
    }
    const dashboardPort = port ?? runtime.freshInstall.port;
    const url = `http://192.0.2.15:${dashboardPort}/`;
    const dashboardUrls = page.getByRole("group", { name: "Dashboard URLs" });
    for (const address of ["127.0.0.1", "192.0.2.15", "100.64.0.2"]) {
      await expect(dashboardUrls.getByRole("link", { name: `http://${address}:${dashboardPort}`, exact: true })).toBeVisible();
    }
    if (port) await expect(dashboardUrls.getByRole("link", { name: "http://100.64.0.2:3118", exact: true })).toHaveCount(0);
    await expect(page.getByText("Open on another device", { exact: true })).toBeVisible();
    await expect(page.getByText("Connect to the same network, then scan the QR code or open the link.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: `QR code for ${url}`, exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /QR code for/ })).toHaveCount(1);
    await page.getByRole("switch", { name: /Inactive LAN/ }).click();
    await expect(page.getByRole("img", { name: /QR code for/ })).toHaveCount(1);

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = page.getByRole("button", { name: `Copy link for ${url}`, exact: true });
    await copy.click();
    await expect(page.getByText("Link copied.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    // Exercise the plain HTTP fallback with the real browser copy command.
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
    await copy.click();
    await expect(page.getByText("Link copied.", { exact: true })).toBeVisible();
    await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      document.execCommand = () => false;
    });
    await copy.click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not copy the link." })).toBeVisible();

    protectedAccess = true;
    activeHosts = ["0.0.0.0"];
    await page.reload();
    await openAccess();
    await expect(page.getByRole("img", { name: /QR code for/ })).toHaveCount(2);
    await expect(page.getByText("Connect to the same network, then scan the QR code or open the link and sign in with your dashboard password.", { exact: true })).toBeVisible();
  });
});

test("setup wizard applies native recording-folder choices immediately and safely", async ({ page, request }) => {
  test.setTimeout(120_000);
  await resetFreshInstallState();
  const access = await request.get("/api/auth/status");
  expect(access.ok()).toBe(true);
  if ((await access.json() as { pending: boolean }).pending) {
    const setup = await request.post("/api/auth/setup", { data: { password: null, exposureConfirmed: true } });
    expect(setup.ok()).toBe(true);
  }
  await page.goto("/onboarding?welcome=true", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Get Started", exact: true }).click();
  for (let step = 0; step < 6; step++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
  const initialStatus = await (await page.request.get("/api/storage/recording-directory")).json() as { directory: string };
  const nestedDestination = resolve(initialStatus.directory, "raceiq");
  let selectionCount = 0;
  let releasePicker!: () => void;
  let pickerGate = new Promise<void>((resolve) => { releasePicker = resolve; });
  let releaseMove!: () => void;
  let moveGate = new Promise<void>((resolve) => { releaseMove = resolve; });
  let moveRequests = 0;
  await page.route("**/api/storage/select-directory", async (route) => {
    selectionCount++;
    if (selectionCount === 1) {
      await pickerGate;
      await route.fulfill({ json: { directory: null } });
    } else if (selectionCount === 2) {
      await route.fulfill({ json: { directory: SETTINGS_PATH } });
    } else {
      await route.fulfill({ json: { directory: nestedDestination } });
    }
  });
  await page.route("**/api/storage/recording-directory", async (route) => {
    if (route.request().method() === "POST") {
      moveRequests++;
      if (moveRequests > 0) await moveGate;
    }
    await route.continue();
  });
  try {
    const changeFolder = page.getByRole("button", { name: "Change folder", exact: true });
    await changeFolder.click();
    await expect(page.getByRole("button", { name: "Next", includeHidden: true })).toBeDisabled();
    const backButton = page.getByRole("button", { name: "Back", exact: true });
    await expect(backButton).toHaveCount(1);
    await expect(backButton).toBeDisabled();
    releasePicker();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
    expect(moveRequests).toBe(0);

    await changeFolder.click();
    await expect(page.getByRole("alert")).toHaveText("Choose a valid folder.");
    expect(moveRequests).toBe(0);
    await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use this folder", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Move recordings?", exact: true })).toHaveCount(0);

    await changeFolder.click();
    await expect(page.getByRole("button", { name: "Next", includeHidden: true })).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => moveRequests).toBe(1);
    releaseMove();
    await expect.poll(async () => {
      const status = await (await page.request.get("/api/storage/recording-directory")).json() as { state: string; directory: string };
      return status.state === "complete" && status.directory === realpathSync(nestedDestination);
    }, { timeout: 60_000 }).toBe(true);
    expect(moveRequests).toBe(1);
    await expect(page.getByTitle(realpathSync(nestedDestination))).toBeVisible();
  } finally {
    releasePicker();
    releaseMove();
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: Number(runtime.freshInstall.udpPort) }));
  }
});
