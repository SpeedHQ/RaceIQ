import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { collectBrowserErrors } from "../../support/browser-errors";
import { opponentReplay, opponentSessions } from "./engineer-replay-opponents.fixture";

declare global {
  interface Window {
    replayAudioProbe: {
      playbackContexts: number;
      started: number;
      stopped: number;
      closed: number;
      pending: number;
      suspend(): void;
      resume(): void;
    };
  }
}

test.use({ viewport: { width: 1440, height: 900 } });

test("ACC replay shares sorted player-focused standings, source loss, and timeline clearance", async ({ page }, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: opponentSessions }));
  await page.route("**/api/dev/live-engineer/session-replay?*", (route) => route.fulfill({ json: opponentReplay() }));
  await page.goto("/dev/speech/engineer-replay?gameId=acc&sessionId=91001");
  const panel = page.getByRole("region", { name: "ACC standings" });
  const table = panel.getByRole("table");
  await expect(table).toBeVisible();
  const drivers = table.locator("tbody tr").filter({ hasText: /Driver \d+/ });
  await expect(drivers).toHaveCount(6);
  expect(await drivers.locator("td:nth-child(2)").allTextContents()).toEqual(["Driver 1", "Driver 6", "Driver 7", "Driver 8", "Driver 9", "Driver 10"]);
  await expect(table.locator('tr[aria-current="true"]')).toContainText("Driver 8");
  await expect(table.locator('tr[aria-current="true"]')).toContainText("GT3");
  await expect(table.locator('tr[aria-current="true"]')).toContainText("1:31.234 (invalid)");
  await expect(table.locator('tr[aria-current="true"]')).toContainText("Pit lane");
  await expect(table.locator('tr[aria-current="true"]')).toContainText("Disconnected");
  await expect(table.locator("thead > tr > th")).toHaveCount(8);
  await expect(table.locator("tr > tr")).toHaveCount(0);
  await panel.getByRole("button", { name: "Show all (12)" }).click();
  await expect(drivers).toHaveCount(12);
  expect(await drivers.locator("td:first-child").allTextContents()).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
  await page.locator("main").last().evaluate((main) => {
    const scroll = main.parentElement!;
    scroll.scrollTop = scroll.scrollHeight;
  });
  const lastRow = drivers.last();
  const timeline = page.locator('[aria-label="Session timeline"]');
  await expect.poll(async () => {
    const row = await lastRow.boundingBox();
    const sticky = await timeline.boundingBox();
    return row && sticky ? row.y + row.height <= sticky.y && row.y >= 0 : false;
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("acc-expanded-timeline-clearance.png") });
  await panel.getByRole("button", { name: "Focus view" }).click();
  await expect(drivers).toHaveCount(6);
  const slider = page.getByRole("slider", { name: "Replay frame" });
  for (const [index, state] of [[1, "unavailable"], [2, "stale"], [3, "malformed"]] as const) {
    await slider.fill(String(index));
    await expect(table).toHaveCount(0);
    await expect(panel.getByRole("status")).toContainText(`Opponent standings ${state}`);
    await expect(page.getByText("Track and frame context", { exact: true })).toBeAttached();
  }
  await slider.fill("4");
  await expect(table).toBeVisible();
  await expect(table.locator('tr[aria-current="true"]')).toContainText("Driver 8");
  expect(browserErrors.errors).toEqual([]);
});

for (const selection of ["session", "game"] as const) {
  test(`late replay response cannot replace changed ${selection} selection`, async ({ page }) => {
    let releaseOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
    let requestedOld = false;
    await page.route("**/api/sessions?*", (route) => route.fulfill({ json: opponentSessions }));
    await page.route("**/api/dev/live-engineer/session-replay?*", async (route) => {
      const id = Number(new URL(route.request().url()).searchParams.get("sessionId"));
      if (id === 91001) {
        requestedOld = true;
        await oldResponse;
        const replay = opponentReplay(id);
        await route.fulfill({ json: { ...replay, frames: replay.frames.map((frame) => ({ ...frame, opponentSource: { source: "acc-broadcast", state: "malformed", reasonCode: "old-response" } })) } });
      } else await route.fulfill({ json: opponentReplay(id) });
    });
    await page.goto("/dev/speech/engineer-replay?gameId=acc&sessionId=91001");
    await expect.poll(() => requestedOld).toBe(true);
    if (selection === "session") {
      await page.getByRole("combobox", { name: "Session", exact: true }).click();
      await page.getByRole("option").filter({ hasText: "Car 91002" }).click();
      await expect(page.getByRole("table", { name: "ACC standings" })).toBeVisible();
    } else {
      await page.getByRole("combobox", { name: "Game", exact: true }).click();
      await page.getByRole("option").filter({ hasText: "F1" }).click();
      await expect(page.getByRole("button", { name: "Load session", exact: true })).toBeDisabled();
    }
    const response = page.waitForResponse((response) => response.url().includes("session-replay?") && response.url().includes("sessionId=91001"));
    releaseOld();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText(/old-response/)).toHaveCount(0);
    if (selection === "session") await expect(page.getByRole("table", { name: "ACC standings" })).toBeVisible();
    else await expect(page.getByRole("region", { name: "ACC standings" })).toHaveCount(0);
  });
}

test("replay audio reuses context, cancels suspended requests, and stops active nodes on mute and unmount", async ({ page }) => {
  await page.addInitScript(() => {
    const contexts: TestAudioContext[] = [];
    const pending: (() => void)[] = [];
    const probe = {
      playbackContexts: 0, started: 0, stopped: 0, closed: 0, pending: 0,
      resume() { for (const resolve of pending.splice(0)) resolve(); },
      suspend() { for (const context of contexts) if (context.state !== "closed") context.state = "suspended"; },
    };
    class TestAudioContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      played = false;
      constructor() { contexts.push(this); }
      async resume() {
        probe.pending += 1;
        await new Promise<void>((resolve) => pending.push(resolve));
        probe.pending -= 1;
        this.state = "running";
      }
      async close() { this.state = "closed"; if (this.played) probe.closed += 1; }
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      createBiquadFilter() { return { frequency: { value: 0 }, connect() {} }; }
      createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect() {} }; }
      createWaveShaper() { return { connect() {} }; }
      async decodeAudioData() { return { duration: 1, getChannelData: () => new Float32Array([0, 0.5, 0]) }; }
      createBufferSource() {
        if (!this.played) { this.played = true; probe.playbackContexts += 1; }
        return {
          buffer: null, onended: null as (() => void) | null, connect() {},
          start() { probe.started += 1; },
          stop() { probe.stopped += 1; this.onended?.(); },
        };
      }
    }
    Object.defineProperty(window, "AudioContext", { value: TestAudioContext });
    Object.assign(window, { replayAudioProbe: probe });
  });
  const bytes = Buffer.from([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await page.route("**/audio/live-engineer/qwen-v3/manifest.json", (route) => {
    return route.fulfill({ json: {
      catalogVersion: "live-engineer-qwen-v3",
      clips: [{ segmentId: "test-segment", path: "test.wav", sha256, durationMs: 1_000 }],
      fullLines: [{ lineId: "test-line", path: "test.wav", sha256, durationMs: 1_000 }],
    } });
  });
  await page.route("**/audio/live-engineer/qwen-v3/test.wav", (route) => route.fulfill({ body: bytes, contentType: "audio/wav" }));
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: opponentSessions }));
  await page.route("**/api/dev/live-engineer/session-replay?*", (route) => route.fulfill({ json: opponentReplay() }));
  await page.goto("/dev/speech/engineer-replay?gameId=acc&sessionId=91001");
  await expect(page.getByRole("button", { name: "Play segments", exact: true })).toBeVisible();
  for (const kind of ["segments", "full-line"]) {
    await page.evaluate(() => window.replayAudioProbe.suspend());
    await page.getByRole("button", { name: `Play ${kind}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.replayAudioProbe.pending)).toBe(1);
    await page.getByRole("button", { name: /^(Auto audio|Audio muted)$/ }).click();
    await page.evaluate(() => window.replayAudioProbe.resume());
    await expect.poll(() => page.evaluate(() => window.replayAudioProbe.pending)).toBe(0);
    expect(await page.evaluate(() => window.replayAudioProbe.started)).toBe(0);
  }
  await page.getByRole("button", { name: "Play segments", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.replayAudioProbe.started)).toBe(1);
  await page.getByRole("button", { name: "Auto audio", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.replayAudioProbe.stopped)).toBe(1);
  await page.getByRole("button", { name: "Play full-line", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.replayAudioProbe.started)).toBe(2);
  expect(await page.evaluate(() => window.replayAudioProbe.playbackContexts)).toBe(1);
  await page.locator('a[href="/"]:visible').first().click();
  await expect.poll(() => page.evaluate(() => {
    const probe = window.replayAudioProbe;
    return { stopped: probe.stopped, closed: probe.closed };
  })).toEqual({ stopped: 2, closed: 1 });
});
