import { expect, test } from "@playwright/test";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { iterateSessionCaptureRecords } from "../../../packages/capture-formats/src/session/framing";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { cleanDisposable, importDisposableLap, lapsFor, type DisposableImport } from "../support/session-fixtures";

const path = process.env.RACEIQ_F1_2026_MANIFEST;
const startLap = Number(process.env.RACEIQ_F1_2026_LAP_START ?? "5");
type Chunk = { kind: string; lapNumber?: number; path: string; ownedFrameByteOffset: number; ownedFrameCount: number; trailingContextFrameCount?: number };

test("private complete F1 2026 laps survive UDP capture, Replay, Compare and export/import", async ({ page, request }) => {
  test.skip(!path, "Set RACEIQ_F1_2026_MANIFEST to a private captured session manifest.");
  test.setTimeout(240_000);
  const manifest = JSON.parse(readFileSync(path!, "utf8")) as { gameId: string; chunks: Chunk[] };
  expect(manifest.gameId).toBe("f1-2025");
  const chunks = manifest.chunks.filter((chunk) => chunk.kind === "lap" && chunk.lapNumber !== undefined && chunk.lapNumber >= startLap && chunk.lapNumber < startLap + 3).sort((a, b) => a.lapNumber! - b.lapNumber!);
  expect(chunks.map((chunk) => chunk.lapNumber)).toEqual([startLap, startLap + 1, startLap + 2]);
  const frames: Buffer[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const file = join(dirname(path!), chunk.path);
    const records = [...iterateSessionCaptureRecords(readFileSync(file), 0, { strict: true })].filter((record) => record.kind === "frame");
    const packets = readUdpDump(file);
    expect(records.length).toBe(packets.length);
    const offset = records.findIndex((record) => record.offset === chunk.ownedFrameByteOffset);
    expect(offset).toBeGreaterThanOrEqual(0);
    const end = offset + chunk.ownedFrameCount + (index === chunks.length - 1 ? chunk.trailingContextFrameCount ?? 0 : 0);
    expect(end).toBeLessThanOrEqual(packets.length);
    frames.push(...packets.slice(index === 0 ? 0 : offset, end));
  }
  expect(frames.length).toBeGreaterThan(10_000);
  expect(frames.every((frame) => frame.readUInt16LE(0) === 2026)).toBe(true);
  // Last-lap milliseconds come directly from EA's player LapData packets.
  const nativeTimes = new Map<number, number>();
  for (const frame of frames) {
    if (frame[6] !== 2 || frame.length < 29) continue;
    const offset = 29 + 57 * frame[27]!;
    if (offset + 34 > frame.length) continue;
    const time = frame.readUInt32LE(offset);
    if (time > 0) nativeTimes.set(frame[offset + 33]! - 1, time / 1000);
  }
  const previous = new Set((await lapsFor(request, "f1-2025")).map((lap) => lap.id));
  await page.goto("/live");
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.connect(15332, "127.0.0.1", resolve); });
  let stopped = false;
  let imported: DisposableImport | undefined;
  const playback = (async () => {
    let previousUid = "", previousTime = 0, pendingDelay = 0;
    for (let index = 0; index < frames.length && !stopped; index++) {
      const frame = frames[index]!;
      const uid = frame.readBigUInt64LE(7).toString(), time = frame.readFloatLE(15);
      if (uid === previousUid) pendingDelay += Math.max(0, time - previousTime) * 250;
      previousUid = uid; previousTime = time;
      await new Promise<void>((resolve, reject) => socket.send(frame, (error) => error ? reject(error) : resolve()));
      if (index % 20 === 0) { await delay(Math.max(5, pendingDelay)); pendingDelay = 0; }
    }
  })();
  void playback.catch(() => { stopped = true; });
  try {
    await expect(page.getByRole("status").first()).toHaveAttribute("aria-label", /Receiving/, { timeout: 30_000 });
    await playback;
    const capturedLaps = async () => (await lapsFor(request, "f1-2025")).filter((lap) => !previous.has(lap.id) && lap.isValid && lap.telemetryAvailable && lap.processing.state === "ready").sort((a, b) => (a.rawFrameCount ?? Infinity) - (b.rawFrameCount ?? Infinity));
    await expect.poll(async () => (await capturedLaps()).length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
    const [lapA, lapB] = await capturedLaps();
    for (const lap of await capturedLaps()) {
      expect(nativeTimes.has(lap.lapNumber)).toBe(true);
      expect(lap.lapTime).toBeCloseTo(nativeTimes.get(lap.lapNumber)!, 3);
    }
    const headers = { "X-Game-Id": "f1-2025" };
    const readLap = async (id: number) => {
      const response = await request.get(`/api/laps/${id}`, { headers, timeout: 60_000 });
      expect(response.ok()).toBe(true);
      return await response.json() as { lapTime: number; telemetry: TelemetryPacket[] };
    };
    const captured = await readLap(lapA!.id);
    expect(captured.telemetry.length).toBeGreaterThan(100);
    expect(captured.telemetry.every((packet) => packet.f1?.packetFormat === 2026)).toBe(true);
    await page.goto(`/f125/sessions/${lapA!.sessionId}/replay/${lapA!.id}`);
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
    const query = new URLSearchParams({ track: lapA!.trackId, carA: lapA!.carId, carB: lapB!.carId, lapA: String(lapA!.id), lapB: String(lapB!.id), view: "compare" });
    await page.goto(`/f125/compare?${query}`);
    await expect(page.getByTestId("lap-compare-workspace")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("compare-time-delta")).toBeVisible({ timeout: 30_000 });
    imported = await importDisposableLap(request, "f1-2025", "private-f1-2026", lapA!.id);
    await expect.poll(async () => (await lapsFor(request, "f1-2025")).find((lap) => lap.id === imported!.lapIds[0])?.processing.state, { timeout: 90_000 }).toBe("ready");
    const restored = await readLap(imported.lapIds[0]!);
    expect(restored.lapTime).toBeCloseTo(captured.lapTime, 3);
    expect(restored.telemetry.some((packet) => packet.f1?.packetFormat === 2026)).toBe(true);
  } finally {
    stopped = true;
    try { await playback; } finally { socket.close(); await cleanDisposable(request, imported, "f1-2025"); }
  }
});
