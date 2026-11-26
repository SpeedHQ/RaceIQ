import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { inArray } from "drizzle-orm";
import { decodeSemanticLapTelemetry, SEMANTIC_REPLAY_MEDIA_TYPE } from "@raceiq/lap-replay/contracts";
import { replayRoutes } from "@raceiq/lap-replay/server";
import { prepareSpectateLap } from "@raceiq/lap-replay/test-support/spectate-replay";
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

test.each([
  { scenario: "uninterrupted lap", rewindTo: 25, quit: false, reason: null },
  { scenario: "long flashback", rewindTo: 10, quit: false, reason: "rewind" },
  { scenario: "quit after flashback", rewindTo: 24, quit: true, reason: "incomplete" },
])("live F1 capture and replay: $scenario", async ({ rewindTo, quit, reason }) => {
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
  resetParserState("f1-2025");
  let resume = -1;
  let stop = original.length;
  for (let i = 0; i < original.length; i++) {
    const packet = parsePacket(original[i]!);
    if (packet?.LapNumber !== 2 || original[i]!.readBigUInt64LE(7) !== uid) continue;
    if (resume < 0 && packet.CurrentLap >= rewindTo) resume = i;
    if (packet.CurrentLap >= 32) { if (quit) stop = i; break; }
  }
  expect(resume).toBeGreaterThanOrEqual(0);
  const frames = reason === null ? original : original.slice(0, target).concat(original.slice(resume, stop));
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
    const affected = stored.find((lap) => lap.lapNumber === 2 && lap.invalidReason === reason);
    expect(affected).toBeDefined();
    const [raw] = await getLapsByIds([affected!.id]);
    expect(raw!.parseError).toBeFalsy();
    expect(raw!.telemetry.some((p, i, all) => i > 0 && p.TimestampMS < all[i - 1]!.TimestampMS)).toBe(reason !== null);
    const response = await replayRoutes.request(`/api/laps/${affected!.id}/semantic-telemetry`, {
      headers: { "X-Game-Id": "f1-2025", Accept: SEMANTIC_REPLAY_MEDIA_TYPE },
    });
    expect(response.status).toBe(200);
    const body = decodeSemanticLapTelemetry(await response.json());
    const times = body.envelopes.map((frame) => Number(frame.values.find((v) => v.semanticId === "timing.current-lap")!.value));
    expect(times[0]).toBe(0);
    expect(times.every((time, i) => !i || time >= times[i - 1]!)).toBe(true);
    expect(prepareSpectateLap(body).duration).toBeCloseTo(quit ? 31.967 : 87.316, 3);
    if (reason === null) expect(times).toEqual(raw!.telemetry.map((p) => p.CurrentLap));
    if (!quit) {
      const later = stored.find((lap) => lap.sessionId === affected!.sessionId && lap.lapNumber === 3 && lap.isValid);
      expect(later).toBeDefined();
      const [replayed] = await getLapsByIds([later!.id]);
      expect(replayed!.parseError).toBeFalsy();
      expect(replayed!.telemetry.length).toBeGreaterThan(30);
      expect(replayed!.telemetry.every((packet) => packet.LapNumber === 3)).toBe(true);
    }
  } finally {
    unsubscribe();
    await pipeline.finalizeCurrentSession().catch(() => {});
    const created = (await db.select().from(sessions).all()).filter((row) => !before.has(row.id));
    if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.map((row) => row.id))).run();
    for (const row of created) if (row.rawFile) await rm(row.rawFile.endsWith("manifest.json") ? dirname(row.rawFile) : row.rawFile, { recursive: row.rawFile.endsWith("manifest.json"), force: true });
  }
}, 180_000);
