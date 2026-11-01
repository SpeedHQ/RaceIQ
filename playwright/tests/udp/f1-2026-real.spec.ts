import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import { sessionsFor } from "../support/session-fixtures";

const recording = process.env.RACEIQ_F1_2026_CAPTURE;

test("private partial F1 2026 capture drives live dashboards through UDP", async ({ page, request }) => {
  test.skip(!recording, "Set RACEIQ_F1_2026_CAPTURE to the private relay capture to run this local gate.");
  test.setTimeout(180_000);
  // This fixture begins after the timed lap's start. It is evidence for live
  // decoding only, not complete-lap, Compare or import/export acceptance.
  const bytes = readFileSync(recording!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("46fdd19219a50349681b109bb358e6adb037d9aee0b7160faca2a025dabd0bd1");
  const frames = readUdpDump(recording!);
  expect(frames).toHaveLength(47_789);
  expect(frames.every((frame) => frame.readUInt16LE(0) === 2026)).toBe(true);
  const oldSessions = new Set((await sessionsFor(request, "f1-2025")).map((session) => session.id));
  await page.goto("/live");
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.connect(15332, "127.0.0.1", resolve); });
  let stopped = false;
  const playback = (async () => {
    let previousUid = "";
    let previousTime = 0;
    let pendingDelay = 0;
    for (let index = 0; index < frames.length && !stopped; index++) {
      const frame = frames[index]!;
      const uid = frame.readBigUInt64LE(7).toString();
      const time = frame.readFloatLE(15);
      if (uid === previousUid) pendingDelay += Math.max(0, time - previousTime) * 250;
      previousUid = uid;
      previousTime = time;
      await new Promise<void>((resolve, reject) => socket.send(frame, (error) => error ? reject(error) : resolve()));
      if (index % 20 === 0) { await delay(Math.max(5, pendingDelay)); pendingDelay = 0; }
    }
  })();
  void playback.catch(() => { stopped = true; });
  try {
    await expect(page.getByText(/Mercedes 2026/).first()).toBeVisible();
    await page.getByRole("navigation").getByRole("link", { name: "F1 2025", exact: true }).click();
    await page.getByRole("navigation").getByRole("link", { name: "Raw", exact: true }).click();
    await expect(page.locator('[data-telemetry-field="f1.packetFormat"] span.font-mono')).toHaveText("2026");
    await expect(page.locator('[data-telemetry-field="f1.ersHarvestLimitPerLap"] span.font-mono')).toHaveText("6600000");
    const speed = page.locator('[data-telemetry-field="Speed"] span.font-mono');
    await expect(speed).toHaveText(/\d/);
    const firstSpeed = await speed.innerText();
    await expect.poll(() => speed.innerText()).not.toBe(firstSpeed);
    await playback;
    expect((await sessionsFor(request, "f1-2025")).some((session) => !oldSessions.has(session.id))).toBe(true);
  } finally {
    stopped = true;
    try { await playback; } finally { socket.close(); }
  }
});
