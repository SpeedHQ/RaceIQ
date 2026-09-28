import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";

const test = base.extend<{ isolatedApi: void }>({
  isolatedApi: [
    async ({ page }, use) => {
      const unexpected: string[] = [];
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        let body: unknown;
        let status = 200;

        if (method === "GET" && path === "/api/settings") body = DEFAULT_DISPLAY_SETTINGS;
        else if (method === "GET" && path === "/api/car-model-configs") body = {};
        else if (method === "GET" && path === "/api/resolve-names") body = { trackNames: { "7": "Spa-Francorchamps", "12": "Nürburgring" }, carNames: { "42": "Huracan GT3", "43": "BMW M4 GT3" } };
        else if (method === "GET" && path === "/api/laps/10/semantic-telemetry") body = {};
        else if (method === "GET" && path === "/api/track-name/7") {
          await route.fulfill({ status: 200, contentType: "text/plain", body: "Spa-Francorchamps" });
          return;
        } else if (method === "GET" && path === "/api/car-name/301") {
          await route.fulfill({ status: 200, contentType: "text/plain", body: "Huracan GT3" });
          return;
        } else if (method === "GET" && path === "/api/acc/cars/42/class") body = { class: "GT3" };
        else if (method === "GET" && /^\/api\/(?:chats\/tune-session-(?:42|43)\/(?:generations|run)|experiments\/(?:42|43)\/chat)$/.test(path)) {
          const sessionId = path.match(/(?:tune-session-|experiments\/)(42|43)/)?.[1];
          const threadId = `tune-session-${sessionId}`;
          body = path.endsWith("/generations")
            ? { activeThreadId: threadId, generations: [{ threadId, generation: 1, active: true }] }
            : path.endsWith("/chat")
              ? { messages: [] }
              : { status: "none" };
        } else if (method === "POST" && path === "/api/laps/aligned-telemetry") {
          status = 500;
          body = { error: "offline fixture" };
        } else if (method === "GET" && path === "/api/acc/cars") body = [{ model: "huracan_gt3_evo2", name: "Huracan GT3" }];
        else {
          unexpected.push(`${method} ${path}`);
          await route.abort();
          return;
        }

        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      await use();
      expect(unexpected, "Storybook snapshot requests must use explicit offline fixtures").toEqual([]);
    },
    { auto: true },
  ],
});

// Seed only absent baselines: Playwright's default "missing" mode writes them
// but still fails the test. Always run the screenshot assertion afterwards so
// capture failures, unstable rendering, and existing image differences still fail.
async function expectScreenshot(target: Page | Locator, name: string, options: { fullPage?: boolean; animations?: "disabled" | "allow"; timeout?: number } = {}) {
  const info = test.info();
  const baseline = info.snapshotPath(name, { kind: "screenshot" });
  if (info.config.updateSnapshots === "missing" && !existsSync(baseline)) {
    const screenshot = await target.screenshot({ animations: "disabled", caret: "hide", scale: "css", ...options });
    mkdirSync(dirname(baseline), { recursive: true });
    try {
      writeFileSync(baseline, screenshot, { flag: "wx" });
    } catch (error) {
      // Another worker may have initialized it while we captured the page.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  await expect(target).toHaveScreenshot(name, options);
}

export { expect, expectScreenshot, test };
