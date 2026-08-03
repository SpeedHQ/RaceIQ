import { expect, test } from "@playwright/test";
import { unlink, writeFile } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";

import { collectBrowserErrors } from "./seeded-e2e-helpers";

const RecordingFilesSchema = z.object({
  files: z.array(z.object({ name: z.string() })),
});

const RecordingPacketsSchema = z.object({
  packets: z.array(z.object({ speed: z.number() })),
});

const ImportResultSchema = z.object({
  ok: z.boolean(),
  packetCount: z.number(),
  laps: z.array(
    z.object({
      lapId: z.number(),
      sessionId: z.number(),
    }),
  ),
});
const SessionListSchema = z.array(z.object({ id: z.number() }));

test("developer recording viewer loads source packets and scrubs values", async ({
  page,
  request,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const filesResponse = await request.get("/api/dev/e2e-files");
  expect(filesResponse.ok()).toBe(true);
  const { files } = RecordingFilesSchema.parse(await filesResponse.json());
  const recording = files.find((file) => file.name.startsWith("fm-2023-"));
  expect(recording).toBeDefined();

  const packetsResponse = await request.get(
    `/api/dev/e2e-packets/${encodeURIComponent(recording!.name)}`,
  );
  expect(packetsResponse.ok()).toBe(true);
  const metadata = RecordingPacketsSchema.parse(await packetsResponse.json());
  expect(metadata.packets.length).toBeGreaterThan(100);
  const firstIndex = metadata.packets.findIndex((packet) => packet.speed > 0);
  const secondIndex = metadata.packets.findIndex(
    (packet, index) =>
      index > firstIndex && Math.abs(packet.speed - metadata.packets[firstIndex].speed) > 1,
  );
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);

  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "E2E Recordings" }).click();
  await page
    .getByRole("button")
    .filter({ hasText: recording!.name })
    .click();
  await expect(
    page.locator('main svg[viewBox="0 0 800 600"] path'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d+ packets/)).toBeVisible();

  const scrubber = page.locator('input[type="range"]');
  await scrubber.fill(String(firstIndex + 1));
  await expect(page.locator("span").filter({ hasText: /^Speed:/ })).toContainText(
    metadata.packets[firstIndex].speed.toFixed(1),
  );
  await scrubber.fill(String(secondIndex + 1));
  await expect(page.locator("span").filter({ hasText: /^Speed:/ })).toContainText(
    metadata.packets[secondIndex].speed.toFixed(1),
  );

  const lapButton = page.getByRole("button", { name: /^L\d+/ }).first();
  await expect(lapButton).toBeVisible();
  await lapButton.click();
  await expect(page.getByText(/^Lap \d+ • /)).toBeVisible();
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await expect(page.getByText("Raw recording", { exact: true })).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in recording viewer").toEqual([]);
});
test("developer state pause and resume controls update state view", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });

  const stateTab = page.getByRole("button", { name: "State", exact: true });
  await stateTab.click();
  const pauseButton = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  expect(browserErrors.errors, "unexpected browser errors in dev state controls").toEqual([]);
});

test("developer recording APIs isolate empty artifacts and report invalid recordings", async ({
  request,
}, testInfo) => {
  const recordingName = `fm-2023-e2e-empty-${testInfo.workerIndex}-${Date.now()}`;
  const artifactPath = resolve(
    __dirname,
    `../test/artifacts/sessions/${recordingName}.bin`,
  );
  await writeFile(artifactPath, Buffer.alloc(0));

  try {
    const filesResponse = await request.get("/api/dev/e2e-files");
    expect(filesResponse.ok()).toBe(true);
    const files = RecordingFilesSchema.parse(await filesResponse.json()).files;
    expect(files.some((file) => file.name === recordingName)).toBe(true);

    const packetResponse = await request.get(
      `/api/dev/e2e-packets/${encodeURIComponent(recordingName)}`,
    );
    expect(packetResponse.ok()).toBe(true);
    expect(await packetResponse.json()).toEqual({ packetCount: 0, packets: [] });

    const lapsResponse = await request.get(
      `/api/dev/e2e-laps/${encodeURIComponent(recordingName)}`,
    );
    expect(lapsResponse.ok()).toBe(true);
    expect(await lapsResponse.json()).toEqual({ laps: [], totalPackets: 0 });

    const svgResponse = await request.get(
      `/api/dev/e2e-svg/${encodeURIComponent(recordingName)}`,
    );
    expect(svgResponse.status()).toBe(400);
    expect(await svgResponse.json()).toMatchObject({
      error: "Failed to parse any packets from recording",
    });

    const missingResponse = await request.get(
      "/api/dev/e2e-packets/fm-2023-does-not-exist",
    );
    expect(missingResponse.status()).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Recording not found" });
  } finally {
    await unlink(artifactPath);
  }

  const filesAfterCleanup = RecordingFilesSchema.parse(
    await (await request.get("/api/dev/e2e-files")).json(),
  ).files;
  expect(filesAfterCleanup.some((file) => file.name === recordingName)).toBe(false);
});
test("developer AC Evo raw inspector decodes replay telemetry values", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const recordingName = "ac-evo-2026-04-15T17-12-25-825Z";
  const packetsResponse = await request.get(
    `/api/dev/e2e-packets/${encodeURIComponent(recordingName)}`,
  );
  expect(packetsResponse.ok()).toBe(true);
  const metadata = RecordingPacketsSchema.parse(await packetsResponse.json());
  expect(metadata.packets.length).toBeGreaterThan(10);
  expect(metadata.packets.some((packet) => packet.speed > 1)).toBe(true);
  const decodedSpeedValues = new Set(
    metadata.packets.map((packet) => packet.speed.toFixed(3)),
  );

  await page.goto("/ac-evo/raw", { waitUntil: "domcontentloaded" });
  const replayResponsePromise = request.post(
    `/api/dev/replay/${recordingName}?packets=120&intervalMs=0`,
  );
  await expect(page.getByText(/All Telemetry Values \(\d+ fields\)/)).toBeVisible({
    timeout: 30_000,
  });
  const replayResponse = await replayResponsePromise;
  expect(replayResponse.ok()).toBe(true);

  const speedRow = page.locator('[data-telemetry-field="Speed"]');
  await expect(speedRow).toBeVisible();
  const speedText = await speedRow.locator("span").last().innerText();
  expect(Number.isFinite(Number(speedText)), `decoded Speed value: ${speedText}`).toBe(true);
  expect(decodedSpeedValues.has(Number(speedText).toFixed(3)), `Speed ${speedText} came from replay source`).toBe(true);

  for (const field of ["CurrentEngineRpm", "Gear", "Accel", "Brake", "Steer"]) {
    const row = page.locator(`[data-telemetry-field="${field}"]`);
    await expect(row, `decoded ${field} field`).toBeVisible();
    await expect(row.locator("span").last()).toHaveText(/^-?\d+(?:\.\d+)?$/);
  }

  for (const name of ["Parsed Packet", "Struct Fields (v0.6)", "Verify (bytes + interp)", "Raw Hex"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }

  const nativeRawResponse = await request.get("/api/ac-evo/debug/raw");
  if (nativeRawResponse.ok()) {
    await page.getByRole("button", { name: "Struct Fields (v0.6)", exact: true }).click();
    await expect(page.getByText(/Page sizes: physics \d+B/)).toBeVisible();
    await page.getByRole("button", { name: "Verify (bytes + interp)", exact: true }).click();
    await expect(page.getByText(/Every field: our expected offset/)).toBeVisible();
    await page.getByRole("button", { name: "Raw Hex", exact: true }).click();
    await expect(page.getByText(/physics: \d+ bytes/)).toBeVisible();
  }

  expect(browserErrors.errors, "unexpected browser errors in AC Evo raw inspector").toEqual([]);
});

test("developer AC Evo native inspection APIs report provider status honestly", async ({
  request,
}) => {
  for (const endpoint of ["raw", "hex", "verify"]) {
    const response = await request.get(`/api/ac-evo/debug/${endpoint}`);
    if (response.status() === 503) {
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("AC Evo"),
      });
      continue;
    }

    expect(response.ok(), `${endpoint} inspection response`).toBe(true);
    const payload = await response.json();
    if (endpoint === "raw") {
      expect(payload.sizes.physics).toBeGreaterThan(0);
      expect(typeof payload.physics.speedKmh).toBe("number");
    } else if (endpoint === "hex") {
      expect(typeof payload.physics).toBe("string");
      expect(typeof payload.graphics).toBe("string");
      expect(typeof payload.staticData).toBe("string");
    } else {
      expect(payload.physics.length).toBeGreaterThan(0);
      expect(payload.graphics.length).toBeGreaterThan(0);
      expect(payload.static.length).toBeGreaterThan(0);
      expect(payload.physics[0]).toEqual(
        expect.objectContaining({
          field: expect.any(String),
          offset: expect.any(Number),
          hex: expect.any(String),
          value: expect.anything(),
        }),
      );
    }
  }
});
test("developer disconnect control closes only isolated browser clients", async ({
  page,
  request,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main").getByText("Server", { exact: true })).toBeVisible();

  const disconnectResponse = await request.post("/api/dev/disconnect");
  expect(disconnectResponse.ok()).toBe(true);
  const disconnectPayload = z
    .object({ ok: z.literal(true), disconnectedClients: z.number().int().nonnegative() })
    .parse(await disconnectResponse.json());
  expect(disconnectPayload.ok).toBe(true);

  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main").getByText("Server", { exact: true })).toBeVisible();
  expect(browserErrors.errors, "unexpected browser errors in dev disconnect flow").toEqual([]);
});



test("developer dump import runs production pipeline and cleans imported state", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/dev", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import Dump" }).click();
  const fixturePath = resolve(
    __dirname,
    "../test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
  );
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  const importResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/dev/import-dump",
  );
  await page.getByRole("button", { name: "Import to Database", exact: true }).click();
  const importResponse = await importResponsePromise;
  expect(importResponse.ok()).toBe(true);
  const result = ImportResultSchema.parse(await importResponse.json());

  try {
    expect(result.ok).toBe(true);
    expect(result.packetCount).toBeGreaterThan(100);
    expect(result.laps.length).toBeGreaterThan(0);
    await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
    await expect(page.getByText("Laps saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open in Analyse" }).first()).toBeVisible();
  } finally {
    const sessionIds = [...new Set(result.laps.map((lap) => lap.sessionId))];
    const cleanup = await request.post("/api/sessions/bulk-delete", {
      data: { ids: sessionIds },
    });
    expect(cleanup.ok(), `cleanup imported sessions ${sessionIds.join(", ")}`).toBe(true);
    const remainingSessionsResponse = await request.get(
      "/api/sessions?gameId=fm-2023",
    );
    expect(remainingSessionsResponse.ok()).toBe(true);
    const remainingSessionIds = new Set(
      SessionListSchema.parse(await remainingSessionsResponse.json()).map(
        (session) => session.id,
      ),
    );
    for (const sessionId of new Set(result.laps.map((lap) => lap.sessionId))) {
      expect(remainingSessionIds.has(sessionId), `imported session ${sessionId} remains`).toBe(false);
    }
  }

  expect(browserErrors.errors, "unexpected browser errors in dump import").toEqual([]);
});
