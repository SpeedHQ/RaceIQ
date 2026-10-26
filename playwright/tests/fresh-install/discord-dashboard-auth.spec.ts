import { createClient } from "@libsql/client";
import { resolve } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { runtime } from "../../config/runtime";

async function resetFreshInstallState() {
  const { dataDir } = runtime.freshInstall;
  if (!dataDir.split(/[\\/]+/).some((part) => part.includes("test-data"))) {
    throw new Error(`Refusing to reset fresh-install state outside test-data: "${dataDir}"`);
  }
  writeFileSync(resolve(dataDir, "settings.json"), JSON.stringify({ udpPort: Number(runtime.freshInstall.udpPort) }));
  rmSync(resolve(dataDir, "app.db.dashboard-access"), { force: true });
  const database = createClient({ url: `file:${resolve(dataDir, "app.db")}` });
  try {
    const results = await database.batch([
      "UPDATE dashboard_access SET mode = 'pending', password_hash = NULL, revision = revision + 1 WHERE id = 1",
      "DELETE FROM dashboard_sessions",
      "DELETE FROM dashboard_auth_method",
      "DELETE FROM local_account_owner",
      "INSERT INTO local_account_owner (id) VALUES (1)",
    ], "write");
    if (Number(results[0]?.rowsAffected) !== 1) throw new Error("Fresh-install dashboard access fixture is missing");
  } finally {
    database.close();
  }
}

test.describe.serial("fresh install Discord dashboard auth", () => {
  test.setTimeout(90_000);

  test("Discord callback completes protected browser login and isolates session", async ({ page, playwright, browser }, testInfo) => {
    await resetFreshInstallState();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "Get Started" }).click();

    const discordChoice = page.getByRole("radio", { name: /RaceIQ Online/ });
    const offlineChoice = page.getByRole("radio", { name: "Offline", exact: true });
    await discordChoice.check();
    await expect(discordChoice).toBeChecked();
    await expect(discordChoice).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Confirm password", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("discord-choice-390.png") });
    await discordChoice.focus();
    await page.keyboard.press("ArrowRight");
    await expect(offlineChoice).toBeChecked();
    await expect(page.getByRole("group", { name: "Password protection", exact: true })).toBeVisible();
    expect(await page.getByRole("group", { name: "Password protection", exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("offline-password-390.png") });
    await page.keyboard.press("ArrowLeft");
    await expect(discordChoice).toBeChecked();
    let callbackUrl = "";
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/auth/discord/callback") callbackUrl = url.href;
    });
    let providerOrigin = "";
    await page.route("https://127.0.0.1:*/auth/v1/authorize**", async (route) => {
      providerOrigin = new URL(route.request().url()).origin;
      const provider = await playwright.request.newContext({ ignoreHTTPSErrors: true });
      try {
        const reset = await provider.post(`${providerOrigin}/__test__/control`, { data: {} });
        expect(reset.status()).toBe(204);
      } finally {
        await provider.dispose();
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Continue with Discord", exact: true }).click();

    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByText(/Online E2E Driver/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm choices and continue", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const response = await page.request.get("/api/auth/status");
      expect(response.ok()).toBe(true);
      return response.json();
    }).toMatchObject({ method: "discord", protected: true, authenticated: true });
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    expect(providerOrigin).toMatch(/^https:\/\/127\.0\.0\.1:/);


    const secondBrowser = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const secondPage = await secondBrowser.newPage();
      await secondPage.goto("/");
      expect((await secondPage.request.get("/api/settings")).status()).toBe(401);
      expect((await secondPage.request.get("/studio-api/")).status()).toBe(401);
      expect(await secondPage.evaluate((port) => new Promise<boolean>((resolve) => {
        const socket = new WebSocket(`ws://localhost:${port}/ws`);
        const timeout = setTimeout(() => { socket.close(); resolve(false); }, 2_000);
        socket.addEventListener("open", () => { clearTimeout(timeout); socket.close(); resolve(true); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timeout); resolve(false); }, { once: true });
      }), runtime.freshInstall.port)).toBe(false);
      const secondStart = await secondPage.evaluate(async () => {
        const response = await fetch("/api/auth/discord/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        return { status: response.status, body: await response.json() };
      });
      expect(secondStart.status).toBe(200);
      await secondPage.goto(new URL(secondStart.body.authorizationUrl).href);
      await expect.poll(async () => (await secondPage.request.get("/api/auth/status")).json()).toMatchObject({ method: "discord", protected: true, authenticated: true });
      await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ method: "discord", protected: true, authenticated: true });
      const provider = await playwright.request.newContext({ ignoreHTTPSErrors: true });
      try {
        const stats = await provider.get(`${providerOrigin}/__test__/stats`);
        expect(stats.ok()).toBe(true);
        expect(await stats.json()).toMatchObject({ oauthExchanges: 2 });
        expect((await stats.json()).developmentRequests).toBeGreaterThan(0);
      } finally {
        await provider.dispose();
      }
    } finally {
      await secondBrowser.close();
    }

    const authStatus = await (await page.request.get("/api/auth/status")).json();
    const logout = await page.evaluate(async (csrf) => {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "x-raceiq-csrf": csrf } });
      return response.status;
    }, authStatus.csrf);
    expect(logout).toBe(200);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ method: "discord", protected: true, authenticated: false });
    expect((await page.request.get("/api/settings")).status()).toBe(401);
    expect(callbackUrl).not.toBe("");
    await page.goto(callbackUrl);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ method: "discord", protected: true, authenticated: false });
    expect((await page.request.post("/api/auth/discord/finish", { data: {} })).status()).toBe(401);
  });
  test("stolen finish, cancellation, and provider failure never grant access", async ({ page, playwright }) => {
    await resetFreshInstallState();
    await page.goto("/login");
    const startAttempt = () => page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() };
    });
    const first = await startAttempt();
    expect(first.status).toBe(200);

    const stolen = await playwright.request.newContext();
    try {
      const response = await stolen.post(new URL("/api/auth/discord/finish", page.url()).href, { data: {} });
      expect(response.status()).toBe(401);
    } finally {
      await stolen.dispose();
    }
    const pending = await page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/finish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() };
    });
    expect(pending).toEqual({ status: 202, body: { status: "pending" } });
    const canceled = await page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() };
    });
    expect(canceled).toEqual({ status: 200, body: { ok: true } });
    const replay = await page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/finish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return response.status;
    });
    expect(replay).toBe(401);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ pending: true, protected: false, authenticated: false });

    const second = await startAttempt();
    expect(second.status).toBe(200);
    const authorizationUrl = new URL(second.body.authorizationUrl);
    const provider = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const control = await provider.post(`${authorizationUrl.origin}/__test__/control`, { data: { tokenFailure: true } });
      expect(control.status()).toBe(204);
    } finally {
      await provider.dispose();
    }
    await page.goto(authorizationUrl.href);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ pending: true, protected: false, authenticated: false });
    const failures = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const stats = await failures.get(`${authorizationUrl.origin}/__test__/stats`);
      expect(await stats.json()).toMatchObject({ oauthExchanges: 1, sharing: "private" });
    } finally {
      await failures.dispose();
    }
  });

  test("tampered callback flow cannot finish or enable sharing", async ({ page, playwright }) => {
    await resetFreshInstallState();
    await page.goto("/login");
    const start = await page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() };
    });
    expect(start.status).toBe(200);
    const authorizationUrl = new URL(start.body.authorizationUrl);
    const provider = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const control = await provider.post(`${authorizationUrl.origin}/__test__/control`, { data: { callbackTamper: true } });
      expect(control.status()).toBe(204);
    } finally {
      await provider.dispose();
    }
    await page.goto(authorizationUrl.href);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ pending: true, protected: false, authenticated: false });
    const statsClient = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const stats = await statsClient.get(`${authorizationUrl.origin}/__test__/stats`);
      expect(await stats.json()).toMatchObject({ sharing: "private" });
    } finally {
      await statsClient.dispose();
    }
  });

  test("wrong Discord account cannot authenticate against existing owner", async ({ page, playwright }) => {
    await resetFreshInstallState();
    const database = createClient({ url: `file:${resolve(runtime.freshInstall.dataDir, "app.db")}` });
    try {
      await database.batch([
        "UPDATE local_account_owner SET online_user_id = 'e2e-online-user' WHERE id = 1",
        "INSERT INTO dashboard_auth_method(id, method) VALUES (1, 'discord')",
        "UPDATE dashboard_access SET mode = 'disabled' WHERE id = 1",
      ], "write");
    } finally {
      database.close();
    }
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const start = await page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() };
    });
    expect(start.status).toBe(200);
    const authorizationUrl = new URL(start.body.authorizationUrl);
    const provider = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const control = await provider.post(`${authorizationUrl.origin}/__test__/control`, { data: { accountId: "attacker-account" } });
      expect(control.status()).toBe(204);
    } finally {
      await provider.dispose();
    }
    await page.goto(authorizationUrl.href);
    const verificationDatabase = createClient({ url: `file:${resolve(runtime.freshInstall.dataDir, "app.db")}` });
    try {
      const owner = await verificationDatabase.execute("SELECT online_user_id FROM local_account_owner WHERE id = 1");
      const method = await verificationDatabase.execute("SELECT method FROM dashboard_auth_method WHERE id = 1");
      expect(owner.rows[0]?.online_user_id).toBe("e2e-online-user");
      expect(method.rows[0]?.method).toBe("discord");
    } finally {
      verificationDatabase.close();
    }

    const statsClient = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const stats = await statsClient.get(`${authorizationUrl.origin}/__test__/stats`);
      expect(await stats.json()).toMatchObject({ oauthExchanges: 1 });
    } finally {
      await statsClient.dispose();
    }
  });

  test("password-protected ownerless install rejects anonymous Discord start and permits CSRF-authenticated transition", async ({ page, playwright }) => {
    await resetFreshInstallState();
    await page.goto("/login");
    const password = "e2e-password-safe";
    const setup = await page.request.post("/api/auth/setup", { data: { password, exposureConfirmed: false } });
    expect(setup.ok()).toBe(true);
    const setupCsrf = setup.headers()["x-raceiq-csrf"];
    if (!setupCsrf) throw new Error("Password setup omitted CSRF token");
    expect((await page.request.post("/api/auth/logout", { data: {}, headers: { "x-raceiq-csrf": setupCsrf } })).ok()).toBe(true);

    const unauthorizedStart = await page.evaluate(async () => {
      const response = await fetch("/api/auth/discord/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: "fr" }) });
      return response.status;
    });
    expect(unauthorizedStart).toBe(401);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ method: "password", protected: true, authenticated: false });

    const login = await page.request.post("/api/auth/login", { data: { password } });
    expect(login.ok()).toBe(true);
    const csrf = login.headers()["x-raceiq-csrf"];
    if (!csrf) throw new Error("Password login omitted CSRF token");
    const currentSettings = await (await page.request.get("/api/settings")).json();
    expect(currentSettings.language).not.toBe("fr");

    const deniedMutation = await page.request.put("/api/settings", { data: { language: "de" } });
    expect(deniedMutation.status()).toBe(403);
    expect((await (await page.request.get("/api/settings")).json()).language).toBe(currentSettings.language);
    const allowedMutation = await page.request.put("/api/settings", { data: { language: "fr" }, headers: { "x-raceiq-csrf": csrf } });
    expect(allowedMutation.ok()).toBe(true);
    expect((await (await page.request.get("/api/settings")).json()).language).toBe("fr");

    const start = await page.evaluate(async (csrf) => {
      const response = await fetch("/api/auth/discord/start", { method: "POST", headers: { "content-type": "application/json", "x-raceiq-csrf": csrf }, body: JSON.stringify({ language: "fr" }) });
      return { status: response.status, body: await response.json() };
    }, csrf);
    expect(start.status).toBe(200);
    const authorizationUrl = new URL(start.body.authorizationUrl);
    const provider = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const control = await provider.post(`${authorizationUrl.origin}/__test__/control`, { data: {} });
      expect(control.status()).toBe(204);
    } finally {
      await provider.dispose();
    }
    await page.goto(authorizationUrl.href);
    await expect.poll(async () => (await page.request.get("/api/auth/status")).json()).toMatchObject({ method: "discord", protected: true, authenticated: true });
    const statsClient = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      const stats = await statsClient.get(`${authorizationUrl.origin}/__test__/stats`);
      expect(await stats.json()).toMatchObject({ oauthExchanges: 1, sharing: "private" });
    } finally {
      await statsClient.dispose();
    }
  });
});
