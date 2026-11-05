import { expect, test } from "@playwright/test";
import { createSocket } from "node:dgram";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import { collectBrowserErrors } from "../support/browser-errors";
import { metricRowText } from "../support/seeded/analyse";
import { cleanDisposable, importDisposableLap, lapsFor, sessionRows, sessionsFor, type DisposableImport } from "../support/session-fixtures";
import { syntheticF1SeasonPackFrames } from "./synthetic-f1-2026";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

for (const format of [2025, 2026] as const) {
  test(`F1 ${format === 2025 ? "2025 real recording" : "2026 synthetic wire stream"} updates dashboards and opens a recorded lap`, async ({ page, request }) => {
    test.setTimeout(240_000); // The full nine-minute driving trace is paced at <=4x.
    // Time-trial captures have no race classification: result lookup returns 404.
    // Other missing resources still fail through the collector's HTTP listener.
    const errors = collectBrowserErrors(page, [
      /THREE\.GLTFLoader: Couldn't load texture/,
      /^http 404: http:\/\/127\.0\.0\.1:\d+\/api\/sessions\/\d+\/result\?gameId=f1-2025$/,
      /^console.error: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
    ]);
    const recording = readUdpDump(resolve(__dirname, "../../..", "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz"));
    const frames = format === 2026 ? syntheticF1SeasonPackFrames(recording) : recording;
    expect(frames.length).toBeGreaterThan(1000);
    expect(frames.every((frame) => frame.readUInt16LE(0) === format)).toBe(true);
    const previousSessions = new Set((await sessionsFor(request, "f1-2025")).map((session) => session.id));
    // F1 uses the same dashboard for both live URLs, without a Pit Crew switch.
    // Open the alias first, then navigate through the actual sidebar controls.
    await page.goto("/live/pit");
    await expect(page.getByRole("status").first()).toHaveAttribute("aria-label", /Server/);

    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(15332, "127.0.0.1", resolve);
    });
    let stopped = false;
    let imported: DisposableImport | undefined;
    // Mock only the game boundary. Real UDP listener, parser, DB and WS remain active.
    // Pace against source session time (at most 4x), not a machine-dependent
    // packets/sec flood. Never catch up with a large burst after a slow browser.
    const playback = (async () => {
      let previousUid = "";
      let previousTime = 0;
      let pendingDelayMs = 0;
      for (let i = 0; i < frames.length && !stopped; i++) {
        const frame = frames[i]!;
        const uid = frame.readBigUInt64LE(7).toString();
        const time = frame.readFloatLE(15);
        if (uid === previousUid) pendingDelayMs += (Math.max(0, time - previousTime) * 1000) / 4;
        previousUid = uid;
        previousTime = time;
        await new Promise<void>((resolve, reject) => socket.send(frame, (error) => (error ? reject(error) : resolve())));
        if (i % 20 === 0) {
          // Keep even zero-timestamp startup packets bounded to small bursts.
          await delay(Math.max(5, pendingDelayMs));
          pendingDelayMs = 0;
        }
      }
    })();
    // Observe failures immediately; cleanup below still awaits and propagates them.
    void playback.catch(() => {
      stopped = true;
    });
    try {
      await expect(page.getByText("DRS", { exact: true }).first()).toBeVisible();
      const current = await metricRowText(page, "Current");
      await expect.poll(() => metricRowText(page, "Current")).not.toBe(current);
      await page.getByRole("navigation").getByRole("link", { name: "Live", exact: true }).click();
      await expect(page).toHaveURL(/\/live$/);
      await expect(page.getByText("DRS", { exact: true }).first()).toBeVisible();

      await page.getByRole("navigation").getByRole("link", { name: "F1 2025", exact: true }).click();
      await page.getByRole("navigation").getByRole("link", { name: "Raw", exact: true }).click();
      const speed = page.locator('[data-telemetry-field="Speed"] span.font-mono');
      await expect(speed).toBeVisible();
      await expect(speed).toHaveText(/\d/);
      const firstSpeed = await speed.innerText();
      await expect.poll(() => speed.innerText()).not.toBe(firstSpeed);
      if (format === 2026) {
        const wireFormat = page.locator('[data-telemetry-field="f1.packetFormat"] span.font-mono');
        await expect(wireFormat).toHaveText("2026");
        const aero = page.locator('[data-telemetry-field="f1.carTelemetry2.activeAeroMode"]');
        await expect(aero).toHaveAttribute("data-telemetry-unit", "enum");
        const firstMode = await aero.locator("span.font-mono").innerText();
        await expect.poll(() => aero.locator("span.font-mono").innerText()).not.toBe(firstMode);
        await expect(page.locator('[data-telemetry-field="f1.carTelemetry2.overtakeActivationDistance"] span.font-mono')).toHaveText("250");
        await expect(page.locator('[data-telemetry-field="f1.ersHarvestLimitPerLap"] span.font-mono')).toHaveText("8000000");
      }

      await playback;
      const capturedSessions = (await sessionsFor(request, "f1-2025")).filter((session) => !previousSessions.has(session.id));
      expect(capturedSessions.length, "UDP produced a new session in this test").toBeGreaterThan(0);
      await page.getByRole("navigation").getByRole("link", { name: "Sessions", exact: true }).click();
      // No seeding/import endpoint: these laps must come from the UDP capture.
      await expect(sessionRows(page).first()).toBeVisible({ timeout: 90_000 });
      await sessionRows(page).first().click();
      const replay = page.getByRole("button", { name: "Replay", exact: true }).first();
      await expect(replay).toBeVisible({ timeout: 90_000 });
      await replay.click();
      await expect(page).toHaveURL(/\/f125\/sessions\/\d+\/replay\/\d+/);
      expect(capturedSessions.map((session) => session.id)).toContain(Number(new URL(page.url()).pathname.split("/")[3]));
      await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });

      const sessionIds = new Set(capturedSessions.map((session) => session.id));
      const capturedLaps = async () =>
        (await lapsFor(request, "f1-2025")).filter((lap) => sessionIds.has(lap.sessionId) && lap.isValid && lap.telemetryAvailable && lap.processing.state === "ready").sort((a, b) => a.id - b.id);
      await expect.poll(async () => (await capturedLaps()).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
      const [lapA, lapB] = await capturedLaps();
      // Native last-lap millisecond readings reviewed in the committed source
      // trace. These are unchanged by the synthetic 2026 re-encoding.
      const expectedTimes: Readonly<Record<number, number>> = { 1: 87.857, 2: 87.316, 3: 86.84, 4: 86.709, 5: 90.704 };
      for (const lap of await capturedLaps()) {
        expect(expectedTimes[lap.lapNumber], `known native timing for lap ${lap.lapNumber}`).toBeDefined();
        expect(lap.lapTime).toBeCloseTo(expectedTimes[lap.lapNumber]!, 3);
      }
      const headers = { "X-Game-Id": "f1-2025" };
      const readLap = async (id: number) => {
        const response = await request.get(`/api/laps/${id}`, { headers, timeout: 60_000 });
        expect(response.ok(), `lap ${id} replay: ${response.status()}${response.ok() ? "" : ` ${await response.text()}`}`).toBe(true);
        return (await response.json()) as { lapTime: number; telemetry: TelemetryPacket[] };
      };
      const captured = await readLap(lapA!.id);
      expect(captured.telemetry.length).toBeGreaterThan(100);
      if (format === 2026) {
        expect(captured.telemetry.every((packet) => packet.f1?.packetFormat === 2026)).toBe(true);
        const modes = new Set(captured.telemetry.map((packet) => packet.f1?.carTelemetry2?.activeAeroMode));
        expect(modes.has(0) && modes.has(1), "recorded aero modes survive replay").toBe(true);
        expect(captured.telemetry.some((packet) => packet.f1?.ersHarvestLimitPerLap === 8_000_000)).toBe(true);
      }

      const query = new URLSearchParams({
        track: lapA!.trackId,
        carA: lapA!.carId,
        carB: lapB!.carId,
        lapA: String(lapA!.id),
        lapB: String(lapB!.id),
        view: "compare",
      });
      await page.goto(`/f125/compare?${query}`);
      await expect(page.getByTestId("lap-compare-workspace")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("compare-time-delta")).toBeVisible({ timeout: 30_000 });

      // Exercise the actual raw export/import boundary, then reopen that imported
      // lap. Source data still originates exclusively from this test's UDP stream.
      imported = await importDisposableLap(request, "f1-2025", `udp-${format}`, lapA!.id);
      await expect.poll(async () => (await lapsFor(request, "f1-2025")).find((lap) => lap.id === imported!.lapIds[0])?.processing.state, { timeout: 90_000 }).toBe("ready");
      const restored = await readLap(imported.lapIds[0]!);
      expect(restored.lapTime).toBeCloseTo(captured.lapTime, 3);
      if (format === 2026) {
        expect(restored.telemetry.some((packet) => packet.f1?.carTelemetry2?.regulations2026 === true)).toBe(true);
        expect(restored.telemetry.some((packet) => packet.f1?.ersHarvestLimitPerLap === 8_000_000)).toBe(true);
      }
      await page.goto(`/f125/sessions/${imported.sessionIds[0]}/replay/${imported.lapIds[0]}`);
      await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
      expect(errors.errors).toEqual([]);
    } finally {
      stopped = true;
      try {
        await playback;
      } finally {
        socket.close();
        await cleanDisposable(request, imported, "f1-2025");
      }
    }
  });
}
