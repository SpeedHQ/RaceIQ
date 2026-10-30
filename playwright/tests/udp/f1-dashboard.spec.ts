import { expect, test } from "@playwright/test";
import { createSocket } from "node:dgram";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import { collectBrowserErrors } from "../support/browser-errors";
import { metricRowText } from "../support/seeded/analyse";
import { sessionRows, sessionsFor } from "../support/session-fixtures";

test("F1 UDP capture updates dashboards and opens a recorded lap", async ({ page, request }) => {
  // Time-trial captures have no race classification: result lookup returns 404.
  // Other missing resources still fail through the collector's HTTP listener.
  const errors = collectBrowserErrors(page, [
    /THREE\.GLTFLoader: Couldn't load texture/,
    /^http 404: http:\/\/127\.0\.0\.1:\d+\/api\/sessions\/\d+\/result\?gameId=f1-2025$/,
    /^console.error: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
  ]);
  const frames = readUdpDump(resolve(__dirname, "../../..", "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz"));
  expect(frames.length).toBeGreaterThan(1000);
  expect(frames.every((frame) => frame.readUInt16LE(0) === 2025)).toBe(true);
  const previousSessions = new Set((await sessionsFor(request, "f1-2025")).map((session) => session.id));
  await page.goto("/live");
  await expect(page.getByRole("status").first()).toHaveAttribute("aria-label", /Server/);

  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(15332, "127.0.0.1", resolve);
  });
  let stopped = false;
  // Mock only the game boundary. Real UDP listener, parser, DB and WS remain active.
  // Pace small bursts so macOS's UDP receive queue is not flooded.
  const playback = (async () => {
    for (let i = 0; i < frames.length && !stopped; i++) {
      await new Promise<void>((resolve, reject) => socket.send(frames[i]!, (error) => error ? reject(error) : resolve()));
      if (i % 20 === 0) await delay(5);
    }
  })();
  // Observe failures immediately; cleanup below still awaits and propagates them.
  void playback.catch(() => { stopped = true; });
  try {
    await expect(page.getByText("DRS", { exact: true }).first()).toBeVisible();
    const current = await metricRowText(page, "Current");
    await expect.poll(() => metricRowText(page, "Current")).not.toBe(current);
    await page.goto("/live/pit");
    await expect(page).toHaveURL(/\/live\/pit$/);
    await expect(page.getByText("DRS", { exact: true }).first()).toBeVisible();

    await page.goto("/f125/raw");
    const speed = page.locator('[data-telemetry-field="Speed"] span.font-mono');
    await expect(speed).toBeVisible();
    await expect(speed).toHaveText(/\d/);
    const firstSpeed = await speed.innerText();
    await expect.poll(() => speed.innerText()).not.toBe(firstSpeed);

    await playback;
    const capturedSessions = (await sessionsFor(request, "f1-2025")).filter((session) => !previousSessions.has(session.id));
    expect(capturedSessions.length, "UDP produced a new session in this test").toBeGreaterThan(0);
    await page.goto("/f125/sessions");
    // No seeding/import endpoint: these laps must come from the UDP capture.
    await expect(sessionRows(page).first()).toBeVisible({ timeout: 90_000 });
    await sessionRows(page).first().click();
    const replay = page.getByRole("button", { name: "Replay", exact: true }).first();
    await expect(replay).toBeVisible({ timeout: 90_000 });
    await replay.click();
    await expect(page).toHaveURL(/\/f125\/sessions\/\d+\/replay\/\d+/);
    expect(capturedSessions.map((session) => session.id)).toContain(Number(new URL(page.url()).pathname.split("/")[3]));
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
    expect(errors.errors).toEqual([]);
  } finally {
    stopped = true;
    try {
      await playback;
    } finally {
      socket.close();
    }
  }
});
