import { expect, test } from "@playwright/test";
import { openStory } from "./storybook-ready";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";

const STORY_IDS = [
  "dashboards-f1livedashboard--visual-contract",
  "dashboards-forzalivedashboard--visual-contract",
  "dashboards-acclivedashboard--visual-contract",
  "dashboards-home-dashboard--per-game",
  "dashboards-sessions--recorded",
  "dashboards-sessions--imported",
  "dashboards-experiments-livetestdashboard--default",
  "dashboards-experiments-workspace--default",
  "dashboards-experiments-flow--workspace-car-focus",
  "dashboards-experiments-flow--workspace-driver-focus",
  "dashboards-experiments-tunereviewdashboard--default",
] as const;

test.setTimeout(300_000);

test("covered stories render without API requests", async ({ page }) => {
  const unexpected: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/resolve-names") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trackNames: { "7": "Spa-Francorchamps", "12": "Nürburgring" }, carNames: { "42": "Huracan GT3", "43": "BMW M4 GT3" } }) });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/laps/10/semantic-telemetry") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
      return;
    }
    const experimentChatMatch = request.method() === "GET" && url.pathname.match(/^\/api\/(?:chats\/tune-session-(42|43)\/(?:generations|run)|experiments\/(42|43)\/chat)$/);
    if (experimentChatMatch) {
      const threadId = `tune-session-${experimentChatMatch[1] ?? experimentChatMatch[2]}`;
      const body = url.pathname.endsWith("/generations")
        ? { activeThreadId: threadId, generations: [{ threadId, generation: 1, active: true }] }
        : url.pathname.endsWith("/chat")
          ? { messages: [] }
          : { status: "none" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    if (url.pathname === "/api/settings") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DEFAULT_DISPLAY_SETTINGS) });
      return;
    }
    if (url.pathname === "/api/acc/cars") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ model: "huracan_gt3_evo2", name: "Huracan GT3" }]) });
      return;
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    await route.abort();
  });

  for (const id of STORY_IDS) {
    await openStory(page, `/iframe.html?id=${id}&viewMode=story`);
    await page.waitForTimeout(100);
  }
  await page.goto("about:blank");

  expect(unexpected).toEqual([]);
});
