import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { eq, inArray } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import { parsePacket, resetParserState, subscribeParserSource } from "@raceiq/backend-core/games/packet-dispatch";
import { DirectSessionRecorderAdapter } from "@raceiq/backend-core/session-capture/direct-recorder";
import { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";
import { readUdpDump } from "@raceiq/backend-core/test-support/recordings/udp";
import { initServerGameAdapters } from "../../src/games/init";

test("live F1 capture saves and replays a repeated packet segment", async () => {
  initServerGameAdapters();
  resetParserState("f1-2025");
  const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
  if (!fixture) throw new Error("F1 recording fixture missing");
  const original = readUdpDump(fixture);
  // Race follows qualifying in this fixture. Locate lap 2 using the real parser.
  let target = -1;
  for (let i = 0; i < original.length; i++) {
    const packet = parsePacket(original[i]!);
    if (packet?.gameId === "f1-2025" && packet.LapNumber === 2 && packet.CurrentLap > 25) { target = i; break; }
  }
  if (target < 0) throw new Error("F1 lap 2 target missing");
  const uid = original[target]!.readBigUInt64LE(7);
  const targetTime = original[target]!.readFloatLE(15);
  let rewindStart = target - 1;
  while (rewindStart > 0 && original[rewindStart]!.readBigUInt64LE(7) === uid && original[rewindStart]!.readFloatLE(15) > targetTime - 1) rewindStart--;
  expect(original[rewindStart]!.readBigUInt64LE(7)).toBe(uid);
  const frames = [...original.slice(0, target), ...original.slice(rewindStart, rewindStart + 100), ...original.slice(target)];
  resetParserState("f1-2025");
  const before = new Set((await db.select({ id: sessions.id }).from(sessions).all()).map((row) => row.id));
  const recorder = new DirectSessionRecorderAdapter("others");
  const failures: unknown[] = [];
  const ws = new class extends NullWsAdapter {
    override broadcastNotification(event: Record<string, unknown>) { if (event.type === "recording-failed") failures.push(event.error); }
  }();
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false }), ws, { recorder, bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true });
  const unsubscribe = subscribeParserSource((input) => pipeline.captureParserSource(input));
  try {
    for (let i = 0; i < frames.length; i++) {
      const bytes = Buffer.from(frames[i]!);
      const packet = parsePacket(bytes);
      if (packet) await pipeline.processPacket(packet, bytes);
      if ((i & 127) === 127) {
        await recorder.drainWrites();
        await nextTurn();
      }
    }
    await pipeline.finalizeCurrentSession();
    unsubscribe();
    expect(failures).toEqual([]);
    const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
    const stored = await db.select().from(laps).where(inArray(laps.sessionId, created.map((row) => row.id))).all();
    const affected = stored.find((lap) => lap.lapNumber === 2 && lap.invalidReason === "rewind");
    expect(affected).toBeDefined();
    const later = stored.find((lap) => lap.sessionId === affected!.sessionId && lap.lapNumber === 3 && lap.isValid);
    expect(later).toBeDefined();
    const replayed = await getLapsByIds([affected!.id, later!.id]);
    expect(replayed).toHaveLength(2);
    expect(replayed.every((lap) => !lap.parseError && lap.telemetry.length > 30)).toBe(true);
    const affectedReplay = replayed.find((lap) => lap.id === affected!.id)!;
    expect(affectedReplay.telemetry.some((packet, index) => index > 0 && packet.TimestampMS < affectedReplay.telemetry[index - 1]!.TimestampMS)).toBe(true);
    expect(replayed.find((lap) => lap.id === later!.id)!.telemetry.every((packet) => packet.LapNumber === 3)).toBe(true);
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map((row) => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 180_000);
