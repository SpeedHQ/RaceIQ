import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "../../server/db/index";
import { laps } from "../../server/db/schema";
import { buildLapsZip } from "../../server/laps/archive";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { reprocessSession } from "../../server/session-capture/reprocess";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { insertSession, updateSessionRawFile, deleteSession } from "../../server/db/session-queries";
import { getSessionRawFile, getSessionTelemetryReplaySource, parseRawLapFrames, parseRawLapFramesFromBuffer, parseSessionLapsBatched } from "../../server/db/telemetry-replay-storage";
import { AccBroadcastState, attachAccBroadcastSnapshot } from "../../server/games/acc/broadcast-state";
import { AccBroadcastCaptureBuffer, encodeAccBroadcastCaptureRecord, type AccBroadcastCaptureBatch, type AccBroadcastCaptureEvent } from "../../server/games/acc/broadcast-capture";
import { parseAccBroadcastMessage } from "../../server/games/acc/broadcast-protocol";
import { ACC_PACKED_MAGIC, packTriplet } from "../../server/games/kunos/pack-triplet";
import { PHYSICS, GRAPHICS, STATIC } from "../../server/games/acc/structs";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame, iterateSessionCaptureRecords } from "../../server/session-capture/framing";
import { indexCaptureFrames, loadSessionSource, type SessionCaptureSource } from "../../server/session-capture/source-loader";
import { readRecordedTelemetry } from "../../server/session-capture/replay-packets";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { RealDbAdapter, NullWsAdapter } from "../../server/telemetry/pipeline-ports";

initGameAdapters();
initServerGameAdapters();
afterAll(stopMaintenanceTasks);

function playerFrame(currentLapMs = 45_000): Buffer {
  const physics = Buffer.alloc(PHYSICS.SIZE);
  physics.writeFloatLE(180, PHYSICS.speedKmh.offset);
  const graphics = Buffer.alloc(GRAPHICS.SIZE);
  graphics.writeInt32LE(2, GRAPHICS.status.offset);
  graphics.writeInt32LE(2, GRAPHICS.session.offset);
  graphics.writeInt32LE(7, GRAPHICS.playerCarID.offset);
  graphics.writeInt32LE(currentLapMs, GRAPHICS.iCurrentTime.offset);
  graphics.writeInt32LE(90_000, GRAPHICS.iLastTime.offset);
  const staticData = Buffer.alloc(STATIC.SIZE);
  staticData.write("bmw_m4_gt3", STATIC.carModel.offset, "utf16le");
  staticData.write("monza", STATIC.track.offset, "utf16le");
  return packTriplet(ACC_PACKED_MAGIC, 0, 0, physics, graphics, staticData);
}

// Protocol-v4 bytes, not mocked decoded messages. Every lap has zero splits.
function datagram(kind: "registration" | "session" | "entries" | "entry" | "car", carIndex = 7, sessionIndex = 1): Buffer {
  const bytes = Buffer.alloc(256);
  let at = 0;
  const u8 = (value: number) => { bytes.writeUInt8(value, at++); };
  const u16 = (value: number) => { bytes.writeUInt16LE(value, at); at += 2; };
  const i32 = (value: number) => { bytes.writeInt32LE(value, at); at += 4; };
  const f32 = (value: number) => { bytes.writeFloatLE(value, at); at += 4; };
  const string = (value: string) => { const text = Buffer.from(value); u16(text.length); text.copy(bytes, at); at += text.length; };
  const lap = () => { i32(91_500); u16(carIndex); u16(0); u8(0); u8(0); u8(1); u8(0); u8(0); };
  if (kind === "registration") {
    u8(1); i32(42); u8(1); u8(0); string("");
  } else if (kind === "session") {
    u8(2); u16(0); u16(sessionIndex); u8(10); u8(5); f32(1_000); f32(600_000); i32(7);
    string(""); string(""); string(""); u8(0); f32(12);
    for (let i = 0; i < 5; i++) u8(0);
    lap();
  } else if (kind === "entries") {
    u8(4); i32(42); u16(2); u16(7); u16(9);
  } else if (kind === "entry") {
    u8(6); u16(carIndex); u8(1); string("Team"); i32(carIndex); u8(0); u8(0); u16(0); u8(1);
    string("Driver"); string(String(carIndex)); string(""); u8(0); u16(0);
  } else {
    u8(3); u16(carIndex); u16(0); u8(1); u8(4); f32(carIndex); f32(1); f32(0); u8(1);
    u16(100); u16(carIndex === 7 ? 2 : 1); u16(1); u16(0); f32(0.5); u16(3); i32(0);
    lap(); lap(); lap();
  }
  return bytes.subarray(0, at);
}

function completeGrid(sessionIndex = 1): Buffer[] {
  return [datagram("session", 7, sessionIndex), datagram("entries"), datagram("entry", 7), datagram("entry", 9), datagram("car", 7), datagram("car", 9)];
}

function capture(batches: readonly AccBroadcastCaptureBatch[]): Buffer {
  const frame = playerFrame();
  return Buffer.concat([encodeMetaFrame(batches.length), ...batches.flatMap((batch) => [encodeAccBroadcastCaptureRecord(batch), encodeFrameLength(frame.length), frame])]);
}

async function withCapture<T>(bytes: Buffer, run: (sessionId: number, source: SessionCaptureSource) => Promise<T>, compressed = false): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-acc-replay-"));
  const rawFile = join(directory, compressed ? "acc.bin.gz" : "acc.bin");
  writeFileSync(rawFile, compressed ? gzipSync(bytes) : bytes);
  const sessionId = await insertSession(1, 1, "acc");
  try {
    await updateSessionRawFile(sessionId, rawFile, "test-detector");
    return await run(sessionId, { rawFile, source: null, gameId: "acc", carOrdinal: 1, trackOrdinal: 1 });
  } finally {
    await deleteSession(sessionId);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("ACC replay matches live snapshots across zero-event clocks, stale, socket loss and fresh recovery", async () => {
  let sequence = 0;
  const events = (at: number, payloads: Buffer[]): AccBroadcastCaptureEvent[] => payloads.map((payload) => ({ sequence: sequence++, receivedAtMs: at, kind: "datagram", payload }));
  const batches: AccBroadcastCaptureBatch[] = [
    { frameReceivedAtMs: 1_000, events: [{ sequence: sequence++, receivedAtMs: 990, kind: "socket-open", payload: Buffer.alloc(0) }, ...events(995, [datagram("registration"), ...completeGrid()])] },
    { frameReceivedAtMs: 2_001, events: [] },
    { frameReceivedAtMs: 2_010, events: events(2_010, completeGrid()) },
    { frameReceivedAtMs: 2_020, events: [{ sequence: sequence++, receivedAtMs: 2_020, kind: "socket-close", payload: Buffer.alloc(0) }] },
    { frameReceivedAtMs: 2_030, events: [{ sequence: sequence++, receivedAtMs: 2_025, kind: "socket-open", payload: Buffer.alloc(0) }, ...events(2_030, [datagram("registration"), ...completeGrid()])] },
  ];
  let clock = 0;
  const live = new AccBroadcastState({ now: () => clock });
  const expected = batches.map((batch) => {
    for (const event of batch.events) {
      clock = event.receivedAtMs;
      if (event.kind === "datagram") live.apply(parseAccBroadcastMessage(event.payload)!, clock);
      else live.setSocketConnected(event.kind === "socket-open");
    }
    clock = batch.frameReceivedAtMs;
    live.setPlayerCarIndex(7);
    const packet = getServerGame("acc").tryParse(playerFrame(), null)!;
    attachAccBroadcastSnapshot(packet, 7, live.snapshot());
    return packet.acc;
  });
  await withCapture(capture(batches), async (sessionId) => {
    const replay = await getSessionTelemetryReplaySource(sessionId, "acc");
    expect(replay.sourceProfile.opponentSourceCapture).toEqual({ source: "acc-broadcast", status: "captured", recordCount: 5 });
    expect(replay.sourceProfile.sourceClockCaptured).toBe(true);
    expect(replay.packets.map((packet) => packet.TimestampMS)).toEqual(batches.map((batch) => batch.frameReceivedAtMs));
    expect(replay.packets.map((packet) => packet.acc)).toEqual(expected);
    expect(replay.packets.map((packet) => packet.acc?.broadcastSource?.state)).toEqual(["available", "stale", "available", "unavailable", "available"]);
  });
});

test("sequence gaps and overflow clear opponents until complete fresh evidence", async () => {
  let sequence = 10;
  const events = (at: number, payloads: Buffer[]): AccBroadcastCaptureEvent[] => payloads.map((payload) => ({ sequence: sequence++, receivedAtMs: at, kind: "datagram", payload }));
  const ready = { frameReceivedAtMs: 1_000, events: [{ sequence: sequence++, receivedAtMs: 990, kind: "socket-open" as const, payload: Buffer.alloc(0) }, ...events(1_000, [datagram("registration"), ...completeGrid()])] };
  sequence++;
  const gap = { frameReceivedAtMs: 1_010, events: events(1_010, [datagram("car")]) };
  const recovered = { frameReceivedAtMs: 1_020, events: events(1_020, completeGrid()) };
  const overflow = { frameReceivedAtMs: 1_030, events: [{ sequence: sequence++, receivedAtMs: 1_030, kind: "queue-overflow" as const, payload: Buffer.alloc(0) }] };
  const recoveredAgain = { frameReceivedAtMs: 1_040, events: events(1_040, completeGrid()) };
  await withCapture(capture([ready, gap, recovered, overflow, recoveredAgain]), async (sessionId) => {
    const { packets } = await getSessionTelemetryReplaySource(sessionId, "acc");
    expect(packets.map((packet) => packet.acc?.broadcastSource?.reasonCode)).toEqual(["ready", "sequence-gap", "ready", "capture-overflow", "ready"]);
    expect(packets[1]!.acc?.broadcastCarIndex).toBeUndefined();
    expect(packets[3]!.acc?.broadcastCarIndex).toBeUndefined();
    expect(packets[4]!.acc?.broadcastCarIndex).toEqual([7, 9]);
    expect(packets.map((packet) => packet.Speed)).toEqual([50, 50, 50, 50, 50]);
  });
});

test("missing per-frame ACCB evidence cannot reuse an earlier available grid", async () => {
  let sequence = 0;
  const events = (at: number, payloads: Buffer[]): AccBroadcastCaptureEvent[] => payloads.map((payload) => ({ sequence: sequence++, receivedAtMs: at, kind: "datagram", payload }));
  const ready = { frameReceivedAtMs: 1_000, events: [{ sequence: sequence++, receivedAtMs: 990, kind: "socket-open" as const, payload: Buffer.alloc(0) }, ...events(995, [datagram("registration"), ...completeGrid()])] };
  const recovered = { frameReceivedAtMs: 1_020, events: events(1_020, completeGrid()) };
  const frame = playerFrame();
  const record = Buffer.concat([encodeFrameLength(frame.length), frame]);
  const bytes = Buffer.concat([encodeMetaFrame(3), encodeAccBroadcastCaptureRecord(ready), record, record, encodeAccBroadcastCaptureRecord(recovered), record]);
  await withCapture(bytes, async (sessionId) => {
    const replay = await getSessionTelemetryReplaySource(sessionId, "acc");
    expect(replay.packets.map((packet) => packet.acc?.broadcastSource?.state)).toEqual(["available", "malformed", "available"]);
    expect(replay.packets[1]!.acc?.broadcastCarIndex).toBeUndefined();
    expect(replay.packets.map((packet) => packet.Speed)).toEqual([50, 50, 50]);
    expect(replay.sourceProfile).toMatchObject({ sourceClockCaptured: false, opponentSourceCapture: { status: "malformed", recordCount: 2 } });
  });
});

test("malformed complete ACCB preserves player frame, reports capture status, and resets clocks at segments", async () => {
  const prefix = encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 5_000, events: [] });
  const malformed = Buffer.from(prefix);
  malformed.writeUInt32LE(1, 24); // Declares an event absent from this complete envelope.
  const frame = playerFrame();
  const record = Buffer.concat([encodeFrameLength(frame.length), frame]);
  const bytes = Buffer.concat([encodeMetaFrame(), prefix, record, malformed, record, encodeSegmentBoundaryFrame(), record]);
  const now = spyOn(Date, "now").mockReturnValue(99_000);
  try {
    await withCapture(bytes, async (sessionId) => {
      const replay = await getSessionTelemetryReplaySource(sessionId, "acc");
      expect(replay.packets.map((packet) => packet.TimestampMS)).toEqual([5_000, 99_000, 99_000]);
      expect(replay.packets[1]!.acc?.broadcastSource?.reasonCode).toBe("malformed-capture-record");
      expect(replay.packets[2]!.acc?.broadcastSource?.state).toBe("unavailable");
      expect(replay.sourceProfile).toMatchObject({ sourceClockCaptured: false, segmentCount: 2, opponentSourceCapture: { status: "malformed", recordCount: 1 } });
    });
  } finally { now.mockRestore(); }
});

for (const compressed of [false, true]) {
  test(`ACCB prefixes support ${compressed ? "gzip" : "plain"} lap reads, indexes and batched windows`, async () => {
    const bytes = capture([1_000, 1_010, 1_020].map((frameReceivedAtMs) => ({ frameReceivedAtMs, events: [] })));
    const records = [...iterateSessionCaptureRecords(bytes)].filter((record) => record.kind === "frame");
    const start = records[1]!.prefixOffset;
    expect(indexCaptureFrames(bytes).byOffset.get(start)?.offset).toBe(records[1]!.offset);
    await withCapture(bytes, async (_sessionId, source) => {
      const streamed = await parseRawLapFrames(source, start, 1);
      const buffered = parseRawLapFramesFromBuffer(bytes, start, 1, "acc");
      const batched = await parseSessionLapsBatched(source, [{ id: 1, rawByteOffset: start, rawFrameCount: 1 }]);
      expect(streamed.map((packet) => packet.CurrentLap)).toEqual([45]);
      expect(buffered.map((packet) => packet.CurrentLap)).toEqual([45]);
      expect(batched.get(1)?.map((packet) => packet.CurrentLap)).toEqual([45]);
    }, compressed);
  });
}

test("legacy ACCP and ACCTEST preserve parser timestamps without claiming captured clocks", async () => {
  const frame = playerFrame();
  const now = spyOn(Date, "now").mockReturnValue(88_000);
  try {
    await withCapture(Buffer.concat([encodeMetaFrame(), encodeFrameLength(frame.length), frame]), async (sessionId) => {
      const replay = await getSessionTelemetryReplaySource(sessionId, "acc");
      expect(replay.packets.map((packet) => packet.TimestampMS)).toEqual([88_000]);
      expect(replay.sourceProfile).toMatchObject({ sourceClockCaptured: false, opponentSourceCapture: { status: "unavailable", recordCount: 0 } });
    });
    for (const version of [2, 3]) {
      const header = Buffer.alloc(16);
      header.write("ACCTEST\0", "ascii"); header.writeUInt32LE(version, 8); header.writeUInt32LE(3, 12);
      const physics = Buffer.alloc(PHYSICS.SIZE);
      const graphics = Buffer.alloc(version === 2 ? 1_320 : GRAPHICS.SIZE);
      graphics.writeInt32LE(2, GRAPHICS.status.offset);
      const staticData = Buffer.alloc(STATIC.SIZE);
      const legacy = Buffer.concat([header, ...[physics, graphics, staticData].flatMap((page, type) => {
        const prefix = Buffer.alloc(5); prefix.writeUInt8(type); prefix.writeUInt32LE(page.length, 1); return [prefix, page];
      })]);
      await withCapture(legacy, async (_sessionId, source) => {
        expect(readRecordedTelemetry("acc", source.rawFile).packets.map((packet) => packet.TimestampMS)).toEqual([88_000]);
      });
    }
  } finally { now.mockRestore(); }
});

test("reprocess and export/import retain ACCB lap offsets, frame counts and source clocks", async () => {
  const records = Array.from({ length: 12 }, (_, index) => {
    const frame = playerFrame(index * 1_000);
    return Buffer.concat([
      encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 100_000 + index * 1_000, events: [] }),
      encodeFrameLength(frame.length), frame,
    ]);
  });
  await withCapture(Buffer.concat([encodeMetaFrame(12), ...records]), async (sessionId) => {
    const processed = await reprocessSession(sessionId);
    expect(processed.lapsDetected).toBe(1);
    const originalLap = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).get();
    expect(originalLap).toMatchObject({ rawByteOffset: 12, rawFrameCount: 12 });
    const exported = await buildLapsZip([originalLap!.id]);
    const files = unzipSync(exported.bytes);
    const exportedCapture = gunzipSync(files[exported.manifest.entries[0]!.file]!);
    const imported = await importSessionBin(exportedCapture, "acc", { notifyDriverProfile: false });
    const importedIds = [...new Set(imported.laps.map((lap) => lap.sessionId))];
    try {
      expect(imported.packetCount).toBe(12);
      expect(importedIds).toHaveLength(1);
      const replay = await getSessionTelemetryReplaySource(importedIds[0]!, "acc");
      expect(replay.sourceProfile).toMatchObject({ sourceClockCaptured: true, opponentSourceCapture: { status: "captured", recordCount: 12 } });
      expect(replay.packets.map((packet) => packet.TimestampMS)).toEqual(Array.from({ length: 12 }, (_, index) => 100_000 + index * 1_000));
      const importedLap = await db.select().from(laps).where(eq(laps.sessionId, importedIds[0]!)).get();
      expect(importedLap?.rawFrameCount).toBe(12);
    } finally {
      for (const importedId of importedIds) await deleteSession(importedId);
    }
  });
});

test("segment boundaries reset Broadcast sequence and session identity before recovery", async () => {
  const events = (sessionIndex: number): AccBroadcastCaptureEvent[] => [
    { sequence: 0, receivedAtMs: 900, kind: "socket-open", payload: Buffer.alloc(0) },
    ...[datagram("registration"), ...completeGrid(sessionIndex)].map((payload, index) => ({
      sequence: index + 1, receivedAtMs: 950, kind: "datagram" as const, payload,
    })),
  ];
  const first = capture([{ frameReceivedAtMs: 1_000, events: events(1) }]);
  const second = capture([{ frameReceivedAtMs: 1_000, events: events(2) }]);
  await withCapture(Buffer.concat([first, encodeSegmentBoundaryFrame(), second.subarray(12)]), async (sessionId) => {
    const replay = await getSessionTelemetryReplaySource(sessionId, "acc");
    expect(replay.packets.map((packet) => packet.acc?.broadcastSource?.state)).toEqual(["available", "available"]);
    expect(replay.packets.map((packet) => packet.acc?.broadcastSessionIndex)).toEqual([1, 2]);
    expect(replay.sourceProfile.segmentCount).toBe(2);
  });
});

test("second independently recorded ACC session retains raw Broadcast baseline after first acknowledgement", async () => {
  const source = new AccBroadcastCaptureBuffer();
  const live = new AccBroadcastState({ now: () => 1_010 });
  source.recordLifecycle("socket-open", 900);
  live.setSocketConnected(true);
  for (const payload of [datagram("registration"), ...completeGrid(), datagram("session"), datagram("car")]) {
    source.recordDatagram(payload, 950);
    live.apply(parseAccBroadcastMessage(payload)!, 950);
  }
  const pipeline = new LiveTelemetryPipeline(new RealDbAdapter({ notifyDriverProfile: false }), new NullWsAdapter(), {
    bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, engineerEnabled: false,
  });
  const sessionIds: number[] = [];
  const rawFrame = playerFrame();
  try {
    for (const clock of [1_000, 1_010]) {
      const cursor = source.prepare(clock);
      const packet = getServerGame("acc").tryParse(rawFrame, null)!;
      live.setPlayerCarIndex(7);
      attachAccBroadcastSnapshot(packet, 7, live.snapshot());
      packet.TimestampMS = clock;
      await pipeline.processPacket(packet, {
        frame: rawFrame,
        capturePrefixRecords: () => [source.encode(cursor)],
        captureSessionContextRecords: () => source.encodeSessionContext(cursor),
        acknowledgeRecorded: () => source.acknowledge(cursor, 7),
      });
      sessionIds.push(pipeline.lapDetector!.session!.sessionId);
      await pipeline.finalizeCurrentSession();
    }
    expect(sessionIds[1]).not.toBe(sessionIds[0]);
    const first = await getSessionTelemetryReplaySource(sessionIds[0]!, "acc");
    const second = await getSessionTelemetryReplaySource(sessionIds[1]!, "acc");
    expect(first.packets[0]!.acc?.broadcastSource?.state).toBe("available");
    expect(second.packets[0]!.acc).toEqual(first.packets[0]!.acc);
    expect(second.packets[0]!.TimestampMS).toBe(1_010);
    expect(second.sourceProfile.sourceClockCaptured).toBe(true);
    const rawFile = await getSessionRawFile(sessionIds[1]!, "acc");
    const loaded = await loadSessionSource({ rawFile: rawFile!, source: null, gameId: "acc", carOrdinal: 1, trackOrdinal: 1 });
    if (loaded.kind !== "capture") throw new Error("Expected canonical ACC capture");
    expect(loaded.frameIndex.records).toHaveLength(1);
    expect(loaded.buffer.readUInt32LE(8)).toBe(1);
    const moreFrames = Array.from({ length: 10 }, (_, index) => Buffer.concat([
      encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 1_020 + index, events: [] }),
      encodeFrameLength(rawFrame.length), rawFrame,
    ]));
    const imported = await importSessionBin(Buffer.concat([loaded.buffer, ...moreFrames]), "acc", { notifyDriverProfile: false });
    const importedIds = [...new Set(imported.laps.map((lap) => lap.sessionId))];
    sessionIds.push(...importedIds);
    expect(importedIds).toHaveLength(1);
    const importedReplay = await getSessionTelemetryReplaySource(importedIds[0]!, "acc");
    expect(importedReplay.packets.map((packet) => packet.acc?.broadcastSource?.state)).toEqual(Array(11).fill("available"));
  } finally {
    await pipeline.finalizeCurrentSession();
    for (const sessionId of sessionIds) await deleteSession(sessionId);
  }
});

test("compacted source context still rejects duplicate event sequences", async () => {
  const events: AccBroadcastCaptureEvent[] = [
    { sequence: 0, receivedAtMs: 900, kind: "socket-open", payload: Buffer.alloc(0) },
    ...[datagram("registration"), ...completeGrid()].map((payload, index) => ({
      sequence: index + 1, receivedAtMs: 950, kind: "datagram" as const, payload,
    })),
  ];
  const duplicate: AccBroadcastCaptureEvent = { sequence: events.at(-1)!.sequence, receivedAtMs: 960, kind: "datagram", payload: datagram("car") };
  const frame = playerFrame();
  const bytes = Buffer.concat([
    encodeMetaFrame(1), encodeSegmentContextFrame(),
    encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 950, events }),
    encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 960, events: [duplicate] }),
    encodeSegmentContextEndFrame(),
    encodeAccBroadcastCaptureRecord({ frameReceivedAtMs: 1_000, events: [] }),
    encodeFrameLength(frame.length), frame,
  ]);
  await withCapture(bytes, async (sessionId) => {
    const replay = await getSessionTelemetryReplaySource(sessionId, "acc");
    expect(replay.packets[0]!.acc?.broadcastSource).toMatchObject({ state: "malformed", reasonCode: "sequence-gap" });
    expect(replay.packets[0]!.acc?.broadcastCarIndex).toBeUndefined();
    expect(replay.packets[0]!.Speed).toBe(50);
  });
});
