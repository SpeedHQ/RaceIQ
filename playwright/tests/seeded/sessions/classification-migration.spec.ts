import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");

test("real upgrade restores attention, preserves it offline, and repairs through feature Retry", async ({ page }, testInfo) => {
  test.setTimeout(720_000);
  const process: ChildProcessWithoutNullStreams = spawn("bun", ["client/test/support/upgrade-browser-server.ts"], {
    cwd: ROOT, env: { ...globalThis.process.env }, stdio: "pipe",
  });
  let output = "";
  let resolveReady!: (address: string) => void;
  let rejectReady!: (error: Error) => void;
  const acknowledgements = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  process.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const match = /UPGRADE_BROWSER_READY=(\{[^\n]+\})/.exec(output);
    if (match) {
      const message: unknown = JSON.parse(match[1]!);
      if (message && typeof message === "object" && "address" in message && typeof message.address === "string") resolveReady(message.address);
      else rejectReady(new Error("Invalid upgrade browser readiness message"));
    }
    for (const [command, acknowledge] of acknowledgements) {
      if (output.includes(`UPGRADE_CONTROL=${command}`)) {
        acknowledgements.delete(command);
        acknowledge.resolve();
      }
    }
  });
  process.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  process.once("error", (error) => {
    rejectReady(error);
    for (const pending of acknowledgements.values()) pending.reject(error);
    acknowledgements.clear();
  });
  process.once("exit", (code) => {
    const error = new Error(`Upgrade server exited ${code}: ${output}`);
    rejectReady(error);
    for (const pending of acknowledgements.values()) pending.reject(error);
    acknowledgements.clear();
  });
  const control = async (command: string) => {
    const marker = `UPGRADE_CONTROL=${command}`;
    output = output.replaceAll(marker, "");
    const done = new Promise<void>((resolve, reject) => {
      acknowledgements.set(command, { resolve, reject });
      // Real subprocess failure deadlines cannot use the browser's fake clock.
      AbortSignal.timeout(30_000).addEventListener("abort", () => {
        if (!acknowledgements.delete(command)) return;
        reject(new Error(`Upgrade control ${command} timed out:\n${output}`));
      }, { once: true });
    });
    process.stdin.write(`${command}\n`);
    await done;
  };
  try {
    const address = await ready;
    await page.goto(address, { waitUntil: "domcontentloaded" });
    const dock = page.getByRole("dialog", { name: "Historical lap classification" });
    const splitDialog = page.getByRole("dialog").filter({ hasText: "Split recordings for faster lap loading?" });
    await expect(splitDialog).toBeVisible();
    await expect(dock).toBeHidden();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(splitDialog).toBeVisible();
      await expect(dock).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`sparse-priority-${width}.png`) });
    }
    await splitDialog.getByRole("button", { name: "Split recordings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sparse recordings split" })).toBeVisible({ timeout: 180_000 });
    await expect(dock).toBeHidden();
    await page.getByRole("dialog", { name: "Sparse recordings split" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sparse recordings split" })).toBeHidden();
    await expect(dock).toContainText("Some recordings need attention");
    await dock.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dock).toBeHidden();

    const classificationPage = await page.context().newPage();
    try {
      for (const width of [390, 1440]) {
        await classificationPage.setViewportSize({ width, height: 900 });
        await classificationPage.goto(new URL("/f125/tracks/0/laps", address).toString(), { waitUntil: "domcontentloaded" });
        const race = classificationPage.getByRole("button", { name: "Race", exact: true }).filter({ visible: true });
        const quali = classificationPage.getByRole("button", { name: "Quali", exact: true }).filter({ visible: true });
        await expect(race).toBeVisible();
        await race.click();
        await expect(classificationPage.getByText("No laps recorded yet", { exact: true })).toBeVisible();
        await classificationPage.screenshot({ path: testInfo.outputPath(`empty-race-${width}.png`) });
        await quali.click();
        await expect(classificationPage.getByText("No laps recorded yet", { exact: true })).toBeHidden();
        await expect(classificationPage.getByText("Best", { exact: true }).filter({ visible: true }).first()).toBeVisible();
      }
    } finally {
      await classificationPage.close();
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    const maintenance = page.locator('section[aria-labelledby="classification-migration-heading"]');
    await expect(maintenance).toContainText("Source file missing");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await maintenance.scrollIntoViewIfNeeded();
      expect(await maintenance.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`classification-attention-${width}.png`) });
    }
    await control("stop-backend");
    await maintenance.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(maintenance.getByRole("alert")).toHaveText("Could not refresh migration status. Last known status is shown.");
    await expect(maintenance).toContainText("Source file missing");
    await control("start-backend");
    await expect(maintenance.getByRole("alert")).toBeHidden({ timeout: 30_000 });
    const trackResponse = await page.request.get(new URL("/api/tracks?gameId=acc", address).toString());
    expect(trackResponse.ok(), "real upgraded ACC track catalog").toBe(true);
    const tracks = await trackResponse.json() as Array<{ id: string | number; lapCount?: number }>;
    const track = tracks.find((candidate) => (candidate.lapCount ?? 0) > 0);
    expect(track, "track with classified recording laps").toBeDefined();
    const trackPage = await page.context().newPage();
    let trackLapRequests = 0;
    trackPage.on("request", (request) => {
      if (request.url().includes("/api/tracks/") && request.url().includes("/all-laps")) trackLapRequests++;
    });
    await trackPage.goto(new URL(`/acc/tracks/${encodeURIComponent(String(track!.id))}/laps`, address).toString(), { waitUntil: "domcontentloaded" });
    await expect.poll(() => trackLapRequests).toBeGreaterThan(0);
    const beforeCommitRefresh = trackLapRequests;
    await control("repair");
    const retry = maintenance.getByRole("button", { name: /^Retry / }).first();
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(maintenance).toContainText("Historical recordings classified.", { timeout: 180_000 });
    await expect(maintenance.getByRole("button", { name: /^Retry / })).toHaveCount(0);
    await expect.poll(() => trackLapRequests).toBeGreaterThan(beforeCommitRefresh);
    const beforeReconnectRefresh = trackLapRequests;
    await control("stop-backend");
    await control("start-backend");
    await expect.poll(() => trackLapRequests, { timeout: 30_000 }).toBeGreaterThan(beforeReconnectRefresh);
    await trackPage.close();
    await page.reload({ waitUntil: "domcontentloaded" });
    const layout = page.getByRole("dialog", { name: "Organize your recordings" });
    await expect(layout).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Historical lap classification" })).toBeHidden();
    await layout.getByRole("button", { name: "Later", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Historical lap classification" })).toContainText("Historical recordings classified.");
  } finally {
    process.stdin.write("quit\n");
    process.stdin.end();
    if (process.exitCode === null) await once(process, "exit");
    await testInfo.attach("upgrade-server", { body: output, contentType: "text/plain" });
  }
});
