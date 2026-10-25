import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../../../../playwright/tests/support/browser-errors";

test.beforeEach(async ({ page, request }, testInfo) => {
  if (!["connected Settings opens website consent without accepting it locally", "Settings clears consent gate after remote acceptance of current policy versions"].includes(testInfo.title)) {
    const classification = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Historical lap classification", exact: true }) });
    await page.addLocatorHandler(classification, async (dialog) => {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    });
  }
  const response = await request.get("/api/online/state");
  expect(response.status()).toBe(200);
  const state = await response.json();
  if (state.connection.status !== "signed_out") {
    const signedOut = await request.post("/api/online/sign-out", { data: { accountEpoch: state.accountEpoch, expectedRevision: state.revision } });
    expect(signedOut.status()).toBe(200);
    expect((await signedOut.json()).state.connection.status).toBe("signed_out");
  }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`signed-out Online settings and delivery history remain available at ${viewport.width}px`, async ({ page, request }, testInfo) => {
    const errors = collectBrowserErrors(page);
    await page.setViewportSize(viewport);
    const stateResponse = await request.get("/api/online/state");
    expect(stateResponse.status()).toBe(200);
    const state = await stateResponse.json();
    expect(state.connection.status).toBe("signed_out");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const classification = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Historical lap classification", exact: true }) });
    await classification.waitFor({ state: "visible" });
    await classification.getByRole("button", { name: "Close", exact: true }).click();
    if (viewport.width < 768) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sign in with Discord", exact: true })).toBeVisible();
    // Mobile settings navigation is collapsed until its menu is opened.
    const menu = dialog.getByRole("button", { name: "Open settings menu", exact: true });
    if (await menu.isVisible()) await menu.click();
    await dialog.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Upload", exact: true })).toBeVisible();
    await expect(dialog.getByText("signed out", { exact: true }).first()).toBeVisible();
    const history = dialog.getByRole("button", { name: "History", exact: true });
    await history.click();
    await expect(history).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByText("No settled deliveries in this history page.", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`online-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    if (viewport.width >= 768) await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    else await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
    expect(errors.errors).toEqual([]);
  });
}

test("Online HTTP boundary rejects foreign origins and stale accounts without changing local state", async ({ request }) => {
  const before = await (await request.get("/api/online/state")).json();
  const foreign = await request.put("/api/online/preferences", {
    headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" },
    data: { accountEpoch: before.accountEpoch, expectedRevision: before.revision, preferences: { visibility: "public", setupUploads: true } },
  });
  expect(foreign.status()).toBe(403);
  expect(await foreign.text()).toBe("Forbidden");
  const stale = await request.post("/api/online/sign-out", {
    data: { accountEpoch: "not-the-current-account", expectedRevision: before.revision },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe("stale_state");
  const after = await (await request.get("/api/online/state")).json();
  expect(after.accountEpoch).toBe(before.accountEpoch);
  expect(after.connection.status).toBe("signed_out");
  expect(after.preferences).toEqual(before.preferences);
});

test("connected Settings changes account preferences and signs out through the real auth callback", async ({ page, request }) => {
  const initial = await (await request.get("/api/online/state")).json();
  const connectResponse = await request.post("/api/online/connect", {
    data: { accountEpoch: initial.accountEpoch, expectedRevision: initial.revision },
  });
  expect(connectResponse.ok()).toBe(true);
  const connect = await connectResponse.json();
  await request.post(`${new URL(connect.authorizationUrl).origin}/__test__/consent`, { data: { accepted: true } });
  await page.goto(connect.authorizationUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You're signed in.", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/online/state")).json()).connection.status).toBe("connected");
  const connectedState = await (await request.get("/api/online/state")).json();
  expect(connectedState.consent.status).toBe("accepted");
  const errors = collectBrowserErrors(page, [
    /^http 409: http:\/\/localhost:\d+\/api\/online\/profile\?accountEpoch=[^&]+&expectedRevision=\d+$/,
    /^console\.error: Failed to load resource: the server responded with a status of 409 \(Conflict\)$/,
  ]);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const classification = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Historical lap classification", exact: true }) });
  await classification.waitFor({ state: "visible" });
  await classification.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Online", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Leaderboard name", { exact: true })).toHaveValue(connectedState.connection.account.displayName);
  const publicPreference = dialog.getByRole("switch", { name: "Make my laps public", exact: true });
  await expect(publicPreference).toBeEnabled();
  if (!(await publicPreference.isChecked())) await publicPreference.click();
  await expect(publicPreference).toBeChecked();
  const setupPreference = dialog.getByRole("switch", { name: "Share setup attachments", exact: true });
  if (!(await setupPreference.isChecked())) await setupPreference.click();
  await expect(setupPreference).toBeChecked();
  const name = dialog.getByLabel("Leaderboard name", { exact: true });
  if (await name.inputValue() !== "Integration Driver") await name.fill("Integration Driver");
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  if (await save.isEnabled()) await save.click();
  await expect.poll(async () => {
    const state = await (await request.get("/api/online/state")).json();
    return [state.preferences.visibility, state.preferences.setupUploads, state.connection.account.displayName];
  }).toEqual(["public", true, "Integration Driver"]);

  await dialog.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(async () => (await (await request.get("/api/online/state")).json()).connection.status).toBe("signed_out");
  expect(errors.errors).toEqual([]);
  await expect(dialog.getByRole("button", { name: "Sign in with Discord", exact: true })).toBeVisible();
});

test("connected Settings opens website consent without accepting it locally", async ({ page, request }) => {
  const initial = await (await request.get("/api/online/state")).json();
  const connectResponse = await request.post("/api/online/connect", {
    data: { accountEpoch: initial.accountEpoch, expectedRevision: initial.revision },
  });
  expect(connectResponse.ok()).toBe(true);
  const connect = await connectResponse.json();
  await request.post(`${new URL(connect.authorizationUrl).origin}/__test__/consent`, { data: { accepted: false } });
  await page.goto(connect.authorizationUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You're signed in.", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/online/state")).json()).connection.status).toBe("connected");
  await page.goto("/?access_token=secret&refresh_token=secret&token=secret&code=secret&state=secret&settings=general#tab=sessions&ACCESS_TOKEN=secret&Refresh_Token=secret&TOKEN=secret&Code=secret&STATE=secret&tab=other");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const policyUrl = "https://raceiq.snazzie.space/flows/consent";
  await page.route(`${policyUrl}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "Controlled consent destination" }));
  const expectedReturn = `${new URL(page.url()).origin}/?settings=general#tab=sessions&tab=other`;
  await dialog.getByRole("button", { name: "Confirm choices and continue", exact: true }).click();
  await page.waitForURL((url) => url.origin === "https://raceiq.snazzie.space" && url.pathname === "/flows/consent");
  const consentUrl = new URL(page.url());
  expect(consentUrl.origin).toBe("https://raceiq.snazzie.space");
  expect(consentUrl.pathname).toBe("/flows/consent");
  expect(consentUrl.searchParams.get("browserReturnTo")).toBe(expectedReturn);
  expect(consentUrl.searchParams.has("desktopReturnTo")).toBe(false);
  for (const key of ["access_token", "refresh_token", "token", "code", "state"]) expect(consentUrl.searchParams.has(key)).toBe(false);
  expect(consentUrl.search).not.toContain("secret");
  expect((await (await request.get("/api/online/state")).json()).consent.status).not.toBe("accepted");
});


test("Settings clears consent gate after remote acceptance of current policy versions", async ({ page, request }) => {
  const initial = await (await request.get("/api/online/state")).json();
  const connectResponse = await request.post("/api/online/connect", {
    data: { accountEpoch: initial.accountEpoch, expectedRevision: initial.revision },
  });
  expect(connectResponse.ok()).toBe(true);
  const connect = await connectResponse.json();
  const consentUrl = `${new URL(connect.authorizationUrl).origin}/__test__/consent`;
  await request.post(consentUrl, { data: { accepted: false } });
  await page.goto(connect.authorizationUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You're signed in.", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/online/state")).json()).connection.status).toBe("connected");
  await page.goto("/?settings=general");
  const connectedState = await (await request.get("/api/online/state")).json();
  expect(connectedState.consent.status).not.toBe("accepted");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  const policyUrl = "https://raceiq.snazzie.space/flows/consent";
  await page.route(`${policyUrl}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "Controlled consent destination" }));
  const expectedReturn = `${new URL(page.url()).origin}/?settings=general`;
  await dialog.getByRole("button", { name: "Confirm choices and continue", exact: true }).click();
  await page.waitForURL((url) => url.origin === "https://raceiq.snazzie.space" && url.pathname === "/flows/consent");
  const consentPageUrl = new URL(page.url());
  expect(consentPageUrl.origin).toBe("https://raceiq.snazzie.space");
  expect(consentPageUrl.pathname).toBe("/flows/consent");
  expect(consentPageUrl.searchParams.get("browserReturnTo")).toBe(expectedReturn);
  expect((await (await request.get("/api/online/state")).json()).consent.status).not.toBe("accepted");

  await request.post(consentUrl, { data: { accepted: true } });
  await page.goto(expectedReturn);
  const refreshedDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(refreshedDialog).toBeVisible();
  const refreshedSettingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect.poll(async () => {
    const state = await (await request.get("/api/online/state")).json();
    return [state.consent.status, state.consent.versions?.termsVersion, state.consent.versions?.privacyVersion];
  }).toEqual(["accepted", connectedState.policy.versions.termsVersion, connectedState.policy.versions.privacyVersion]);
  await expect(refreshedSettingsDialog.getByRole("button", { name: "Confirm choices and continue", exact: true })).toHaveCount(0);

});

test("onboarding opens website consent after connected auth without accepting it locally", async ({ page, request }) => {
  const initial = await (await request.get("/api/online/state")).json();
  const connectResponse = await request.post("/api/online/connect", {
    data: { accountEpoch: initial.accountEpoch, expectedRevision: initial.revision },
  });
  expect(connectResponse.ok()).toBe(true);
  const connect = await connectResponse.json();
  const fixtureResponse = await request.post(`${new URL(connect.authorizationUrl).origin}/__test__/consent`, { data: { accepted: false } });
  expect(fixtureResponse.status()).toBe(204);
  await page.goto(connect.authorizationUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You're signed in.", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/online/state")).json()).connection.status).toBe("connected");

  await page.goto("/onboarding?welcome=true", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Get Started", exact: true }).click();
  await page.getByRole("group").getByRole("radio").nth(0).check();
  await page.getByRole("button", { name: /Continue with Discord/, exact: true }).click();
  await expect(page.getByRole("heading", { name: "RaceIQ Online", exact: true })).toBeVisible();
  const connectedState = await (await request.get("/api/online/state")).json();
  expect(connectedState.consent.status).not.toBe("accepted");

  await page.evaluate(() => sessionStorage.setItem("raceiq:onboarding-flow", JSON.stringify({
    path: "/onboarding",
    choice: "discord",
    step: "online-permissions",
  })));
  await page.goto("/onboarding?welcome=true&step=online-permissions&access_token=secret&refresh_token=secret&token=secret&code=secret&state=secret#discord-review?access_token=secret&state=secret", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Confirm choices and continue", exact: true })).toBeVisible();
  expect((await (await request.get("/api/online/state")).json()).consent.status).not.toBe("accepted");
  const expectedReturn = `${new URL(page.url()).origin}/onboarding?welcome=true&step=online-permissions&redirect=%2F#discord-review`;
  const policyUrl = "https://raceiq.snazzie.space/flows/consent";
  await page.route(`${policyUrl}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "Controlled consent destination" }));
  const consentButton = page.getByRole("button", { name: "Confirm choices and continue", exact: true });
  await consentButton.click();
  await page.waitForURL((url) => url.origin === "https://raceiq.snazzie.space" && url.pathname === "/flows/consent");
  const consentPageUrl = new URL(page.url());
  expect(consentPageUrl.origin).toBe("https://raceiq.snazzie.space");
  expect(consentPageUrl.pathname).toBe("/flows/consent");
  expect(consentPageUrl.searchParams.get("browserReturnTo")).toBe(expectedReturn);
  expect(consentPageUrl.searchParams.get("browserReturnTo")).not.toContain("secret");
  expect(consentPageUrl.searchParams.has("desktopReturnTo")).toBe(false);
  for (const key of ["access_token", "refresh_token", "token", "code", "state"]) expect(consentPageUrl.searchParams.has(key)).toBe(false);
  expect(consentPageUrl.search).not.toContain("secret");
  expect((await (await request.get("/api/online/state")).json()).consent.status).not.toBe("accepted");
});


test("Settings and onboarding keep selected view in URL", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect.poll(() => new URL(page.url()).searchParams.get("settings")).toBe("general");
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await page.keyboard.press("Escape");

  await page.goto("/?settings=upload");
  const returnedSettings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(returnedSettings).toBeVisible();
  await expect(returnedSettings.getByRole("button", { name: "Upload", exact: true })).toHaveClass(/bg-app-accent\/10/);

  const initial = await (await request.get("/api/online/state")).json();
  const connectResponse = await request.post("/api/online/connect", {
    data: { accountEpoch: initial.accountEpoch, expectedRevision: initial.revision },
  });
  expect(connectResponse.ok()).toBe(true);
  const connect = await connectResponse.json();
  await request.post(`${new URL(connect.authorizationUrl).origin}/__test__/consent`, { data: { accepted: false } });
  await page.goto(connect.authorizationUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You're signed in.", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await request.get("/api/online/state")).json()).connection.status).toBe("connected");
  const connectedState = await (await request.get("/api/online/state")).json();
  expect(connectedState.consent.status).not.toBe("accepted");

  await page.evaluate(() => sessionStorage.setItem("raceiq:onboarding-flow", JSON.stringify({
    path: "/onboarding",
    choice: "discord",
    step: "online-permissions",
  })));
  await page.goto("/onboarding?welcome=true&step=online-permissions", { waitUntil: "domcontentloaded" });
  const onboardingUrl = new URL(page.url());
  expect(onboardingUrl.pathname).toBe("/onboarding");
  expect(onboardingUrl.searchParams.get("welcome")).toBe("true");
  expect(onboardingUrl.searchParams.get("step")).toBe("online-permissions");
  await expect(page.getByRole("heading", { name: "RaceIQ Online", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm choices and continue", exact: true })).toBeVisible();
});
test("relocated onboarding choice radio keeps checked, focus, and responsive states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/onboarding?welcome=true", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Get Started", exact: true }).click();
  const offline = page.getByRole("radio", { name: "Offline", exact: true });
  await offline.check();
  await offline.focus();
  await expect(offline).toBeChecked();
  await expect(offline).toBeFocused();
  expect(await offline.locator("xpath=../..").evaluate((label) => getComputedStyle(label).outlineStyle)).toBe("solid");
  const cards = await page.getByRole("group").getByRole("radio").evaluateAll((radios) => radios.map((radio) => {
    const { x, y, width } = radio.closest("label")!.getBoundingClientRect();
    return { x, y, width };
  }));
  expect(cards.every(({ x, width }) => x >= 0 && width > 0 && x + width <= 390)).toBe(true);
  expect(cards[1]!.y).toBeGreaterThan(cards[0]!.y);
  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopCards = await page.getByRole("group").getByRole("radio").evaluateAll((radios) => radios.map((radio) => radio.closest("label")!.getBoundingClientRect().x));
  expect(desktopCards[1]!).toBeGreaterThan(desktopCards[0]!);
});
test("invalid Settings and onboarding steps fall back to safe routes", async ({ page }) => {
  await page.goto("/?settings=not-a-settings-section", { waitUntil: "domcontentloaded" });
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("settings")).toBe("general");
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  await page.goto("/onboarding?welcome=true&step=not-a-step", { waitUntil: "domcontentloaded" });
  const onboardingUrl = new URL(page.url());
  expect(onboardingUrl.pathname).toBe("/onboarding");
  expect(onboardingUrl.searchParams.get("step")).toBe("not-a-step");
  await expect(page.getByRole("button", { name: "Get Started", exact: true })).toBeVisible();
});
