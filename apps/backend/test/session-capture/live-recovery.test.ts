import { Schema } from "effect";
import { FileStreamingSplitterHost, LiveArchiveMemberSchema, openLiveCaptureMember, updateNativeRecordDigest, type StreamingMemberDescriptor } from "@raceiq/capture-splitting";
import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions, liveCaptures, liveCaptureMembers, liveCaptureJournal } from "@raceiq/backend-core/db/schema";
import { beginLiveCapture, bindLiveCaptureSourceIdentity, commitLiveCaptureMember, getLiveLapCaptureSnapshot, persistLiveCaptureProgress, setLiveCaptureStatus } from "@raceiq/backend-core/db/live-capture-queries";
import { encodeFrameLength, encodeMetaFrame, decompressIfGzipSync, iterateSessionCaptureRecords, type SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { recoverLiveCaptureStorage, registerLiveCaptureRecoveryReplay } from "@raceiq/backend-core/session-capture/live-recovery";
import { LiveCanonicalSourceReader } from "../../src/session-capture/live-source-reader";
import { replayLiveCaptureTail } from "../../src/session-capture/live-recovery";
import { createLiveGameParserCodec, ParserTelemetryDigest, replayLiveParserStage } from "../../src/session-capture/live-game-codecs";

const root = await mkdtemp(join(tmpdir(), "raceiq-live-recovery-"));
const sessionIds: number[] = [];
afterAll(async () => {
  for (const id of sessionIds) await db.delete(sessions).where(eq(sessions.id, id)).run();
  await rm(root, { recursive: true, force: true });
});

async function sourcePrefix(count = 16) {
  const fixture = decompressIfGzipSync(await readFile(resolve(import.meta.dir, "../../../../test/artifacts/sessions/fm-2023-with-pitting.bin.gz")));
  const frames: Buffer[] = [];
  for (const record of iterateSessionCaptureRecords(fixture)) {
    if (record.kind === "frame") frames.push(record.frame);
    if (frames.length === count) break;
  }
  const sourcePath = join(root, `source-${randomUUID()}.bin`);
  const recorder = new SparseSessionRecorder("fm-2023");
  recorder.start(sourcePath);
  recorder.writeMetaFrame();
  frames.forEach((frame, index) => recorder.writeRecord(frame, index * 10));
  await recorder.stop();
  return { sourcePath, frames };
}

test("restart recovery replays durable source prefix through pinned reader and real worker", async () => {
  const { sourcePath, frames } = await sourcePrefix();
  const archivePath = join(root, `archive-${randomUUID()}.bin.gz`);
  const session = await db.insert(sessions).values({ carId: "test-car", trackId: "test-track", gameId: "fm-2023", rawFile: sourcePath })
    .returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const identity = { sessionId: session.id, captureEpoch: randomUUID(), attempt: randomUUID() };
  await beginLiveCapture({ ...identity, sourcePath, archivePath });
  const file = Bun.file(sourcePath);
  const length = file.size;
  const uncommittedSuffix = Buffer.concat([encodeFrameLength(frames[0]!.length, 999), frames[0]!]);
  await writeFile(sourcePath, uncommittedSuffix, { flag: "a" });
  const sourceLengthAfterCrash = length + uncommittedSuffix.length;
  const info = await stat(sourcePath, { bigint: true });
  expect(await bindLiveCaptureSourceIdentity(identity, String(info.dev), String(info.ino))).toBe(true);
  expect(await persistLiveCaptureProgress(identity, {
    sequence: 0, sourceByteLength: length, sourceRecordCount: frames.length,
    sourceDurableWatermark: length, metadataDurableWatermark: length,
  }, [])).toBe(true);
  expect(await setLiveCaptureStatus(identity, "recovering")).toBe(true);

  const reader = new LiveCanonicalSourceReader(sourcePath, { device: String(info.dev), inode: String(info.ino) });
  const read = await reader.readBatch(0, length, 64 * 1024, 64);
  await reader.close();
  const replayed = read.records.filter((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  expect(replayed.map((record) => record.frame)).toEqual(frames);
  expect(replayed.map((record) => record.frameTimeMs)).toEqual(frames.map((_, index) => index * 10));
  await replayLiveCaptureTail(identity.captureEpoch);

  const state = await db.select({ status: liveCaptures.status, generation: liveCaptures.generation,
    sourceRecordCount: liveCaptures.sourceRecordCount, sourceDurableWatermark: liveCaptures.sourceDurableWatermark,
    metadataDurableWatermark: liveCaptures.metadataDurableWatermark }).from(liveCaptures)
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get();
  expect(state).toMatchObject({ status: "sealed", generation: 1, sourceRecordCount: frames.length,
    sourceDurableWatermark: length, metadataDurableWatermark: length });
  const members = await db.select().from(liveCaptureMembers).where(eq(liveCaptureMembers.captureEpoch, identity.captureEpoch)).all();
  expect(members).toHaveLength(1);
  const archive = await readFile(archivePath);
  const member = Schema.decodeUnknownSync(LiveArchiveMemberSchema)(JSON.parse(members[0]!.descriptor));
  expect(member).toMatchObject({ kind: "auxiliary", generation: 1, sourceStart: 0, sourceEnd: frames.length,
    recordCount: frames.length, sourceByteEnd: length });
  const nativeRecords = [...iterateSessionCaptureRecords(decompressIfGzipSync(archive), 0, { strict: true })]
    .filter((record) => record.kind === "frame");
  expect(nativeRecords.map((record) => record.frame)).toEqual(frames);
  expect(nativeRecords.map((record) => record.frameTimeMs)).toEqual(frames.map((_, index) => index * 10));
  expect(await stat(sourcePath).then((value) => value.size)).toBe(sourceLengthAfterCrash);
  registerLiveCaptureRecoveryReplay(replayLiveCaptureTail);
  await recoverLiveCaptureStorage();
  const repeated = await db.select({ status: liveCaptures.status, generation: liveCaptures.generation })
    .from(liveCaptures).where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get();
  expect(repeated).toEqual({ status: "sealed", generation: 1 });
  expect(await persistLiveCaptureProgress(identity, {
    sequence: 1, sourceByteLength: length, sourceRecordCount: frames.length,
    sourceDurableWatermark: length, metadataDurableWatermark: length,
  }, [])).toBe(false);
  expect(await db.select().from(liveCaptureMembers).where(eq(liveCaptureMembers.captureEpoch, identity.captureEpoch)).all()).toHaveLength(1);
}, 30_000);

test("restart retains committed lap snapshots, recovers delayed windows, and conserves unbound durable tail", async () => {
  const { sourcePath, frames } = await sourcePrefix();
  const records = [...iterateSessionCaptureRecords(await readFile(sourcePath))].filter(
    (record): record is Extract<SessionCaptureRecord, { kind: "frame" }> => record.kind === "frame");
  const archivePath = join(root, `archive-laps-${randomUUID()}.bin.gz`);
  const session = await db.insert(sessions).values({ carId: "3631", trackId: "860", gameId: "fm-2023", rawFile: sourcePath })
    .returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const lapRows = await db.insert(laps).values([
    { sessionId: session.id, lapNumber: 0, lapTime: 30, rawByteOffset: records[0]!.offset, rawFrameCount: 4 },
    { sessionId: session.id, lapNumber: 1, lapTime: 30, rawByteOffset: records[4]!.offset, rawFrameCount: 4 },
  ]).returning({ id: laps.id }).all();
  const identity = { sessionId: session.id, captureEpoch: randomUUID(), attempt: randomUUID() };
  await beginLiveCapture({ ...identity, sourcePath, archivePath });
  const info = await stat(sourcePath, { bigint: true });
  expect(await bindLiveCaptureSourceIdentity(identity, String(info.dev), String(info.ino))).toBe(true);
  const parserPlan = { gameId: "fm-2023", sequence: 0, anchorSequence: 0, anchorPayload: "", precedingRecords: [] };
  const candidate = (id: string, index: number, lapNumber: number) => ({
    kind: "candidate", candidateId: id, startByteOffset: records[index]!.offset, lapNumber, preparationOnly: false, parserPlan,
  });
  const window = (id: number, index: number, trailingContextFrameCount: number) => ({
    kind: "window", revision: 0, lapId: id, startByteOffset: records[index]!.offset, frameCount: 4, trailingContextFrameCount,
  });
  expect(await persistLiveCaptureProgress(identity, {
    sequence: 5, sourceByteLength: Number(info.size), sourceRecordCount: 16, sourceDurableWatermark: Number(info.size),
    metadataDurableWatermark: records[8]!.endOffset,
  }, [
    { sequence: 1, sourceByteEnd: records[0]!.offset, payload: candidate("first", 0, 0) },
    { sequence: 2, sourceByteEnd: records[4]!.endOffset, payload: window(lapRows[0]!.id, 0, 1) },
    { sequence: 3, sourceByteEnd: records[4]!.offset, payload: candidate("second", 4, 1) },
    { sequence: 4, sourceByteEnd: records[8]!.endOffset, payload: window(lapRows[1]!.id, 4, 0) },
    { sequence: 5, sourceByteEnd: records[8]!.offset, payload: candidate("unfinished", 8, 2) },
  ])).toBe(true);
  const codec = createLiveGameParserCodec("fm-2023");
  const sourceState = codec.createState(), parserDigest = new ParserTelemetryDigest();
  const nativeHash = createHash("sha256"), contextHash = createHash("sha256");
  for (const record of records.slice(0, 4)) {
    updateNativeRecordDigest(nativeHash, record);
    parserDigest.add(codec.parseFrame(record.frame, sourceState, record.frameTimeMs), record.frameTimeMs);
  }
  updateNativeRecordDigest(contextHash, records[4]!);
  const evidence = parserDigest.snapshot();
  const lap = { lapId: String(lapRows[0]!.id), lapNumber: 0, startByteOffset: records[0]!.offset,
    frameCount: 4, trailingContextFrameCount: 1 };
  const bytes = Buffer.concat([encodeMetaFrame(5), ...records.slice(0, 5).flatMap((record) => [
    encodeFrameLength(record.frame.byteLength, record.frameTimeMs), record.frame,
  ])]);
  const descriptor: StreamingMemberDescriptor = {
    id: "000001-lap-0.bin", kind: "lap", lap, firstOrdinal: 0, sourceStart: 0, sourceEnd: 4,
    sourceByteStart: records[0]!.offset, sourceByteEnd: records[3]!.endOffset, recordCount: 4,
    ownedFrameCount: 4, trailingContextFrameCount: 1, nativeDigest: nativeHash.digest("hex"),
    trailingContextDigest: contextHash.digest("hex"), byteLength: bytes.byteLength, ownedFrameByteOffset: 12,
  };
  const host = new FileStreamingSplitterHost({ archivePath, maxQueuedBytes: 1024 * 1024, maxUnresolvedBytes: 1024 * 1024,
    async commit(value) {
      const member = Schema.decodeUnknownSync(LiveArchiveMemberSchema)({ ...value, lapId: lap.lapId, lapNumber: 0,
        entryName: value.id, generation: 1 });
      const accepted = await commitLiveCaptureMember({ identity, priorGeneration: 0, member,
        verification: { nativeDigest: value.nativeDigest, parserReplayVerified: true, parserReplayEvidence: evidence },
        ownershipRevision: 0, ownershipJournalSequence: 2,
        expectedWindow: { lapId: lapRows[0]!.id, startByteOffset: lap.startByteOffset, frameCount: 4 } });
      if (!accepted) throw new Error("Initial production-verified lap publication was fenced");
      return { generation: 1 };
    },
  });
  const stage = await host.createStage("lap", descriptor.id);
  await stage.append(bytes); await stage.close(); await stage.verify(descriptor);
  await replayLiveParserStage("fm-2023", stage, lap, codec, evidence);
  await stage.commit({ ...descriptor, parserReplayVerified: true, parserReplayEvidence: evidence });
  await host.dispose();
  const old = await getLiveLapCaptureSnapshot(session.id, lapRows[0]!.id);
  if (!old) throw new Error("Committed first lap snapshot missing");
  const oldArchive = await openLiveCaptureMember(old.archivePath, old.snapshot);
  const oldBytes = await oldArchive.readEntryBuffer(old.snapshot.member.entryName, 64 * 1024);
  await appendFile(archivePath, Buffer.from("uncommitted archive suffix"));
  registerLiveCaptureRecoveryReplay(replayLiveCaptureTail);
  await recoverLiveCaptureStorage();
  const result = await db.select({ status: liveCaptures.status, generation: liveCaptures.generation,
    metadata: liveCaptures.metadataDurableWatermark }).from(liveCaptures)
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get();
  expect(result).toEqual({ status: "sealed", generation: 3, metadata: Number(info.size) });
  const second = await getLiveLapCaptureSnapshot(session.id, lapRows[1]!.id);
  if (!second) throw new Error("Durable second lap did not recover");
  expect(second.snapshot.member).toMatchObject({ sourceStart: 4, sourceEnd: 8, ownedFrameCount: 4 });
  const secondArchive = await openLiveCaptureMember(second.archivePath, second.snapshot);
  const secondFrames = [...iterateSessionCaptureRecords(await secondArchive.readEntryBuffer(second.snapshot.member.entryName, 64 * 1024))]
    .filter((record) => record.kind === "frame");
  expect(secondFrames.map((record) => record.frame)).toEqual(frames.slice(4, 8));
  expect(secondFrames.map((record) => record.frameTimeMs)).toEqual([40, 50, 60, 70]);
  const oldAfterAppend = await openLiveCaptureMember(old.archivePath, old.snapshot);
  expect(await oldAfterAppend.readEntryBuffer(old.snapshot.member.entryName, 64 * 1024)).toEqual(oldBytes);
  const members = await db.select({ descriptor: liveCaptureMembers.descriptor }).from(liveCaptureMembers)
    .where(eq(liveCaptureMembers.captureEpoch, identity.captureEpoch)).all();
  const tail = members.map((row) => Schema.decodeUnknownSync(LiveArchiveMemberSchema)(JSON.parse(row.descriptor)))
    .find((member) => member.kind === "auxiliary");
  expect(tail).toMatchObject({ sourceStart: 8, sourceEnd: 16, recordCount: 8 });
  const generation = result!.generation;
  await recoverLiveCaptureStorage();
  expect(await db.select({ generation: liveCaptures.generation }).from(liveCaptures)
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get()).toEqual({ generation });
  expect((await stat(sourcePath)).size).toBe(Number(info.size));
  // A late durable observation can name any earlier committed lap, not just the last member.
  await db.insert(liveCaptureJournal).values({ captureEpoch: identity.captureEpoch, sequence: 6,
    sourceByteEnd: Number(info.size), payload: JSON.stringify(window(lapRows[0]!.id, 0, 1)) }).run();
  await db.update(liveCaptures).set({ status: "recovering", durableSequence: 6 })
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).run();
  await replayLiveCaptureTail(identity.captureEpoch);
  expect(await db.select({ generation: liveCaptures.generation, status: liveCaptures.status }).from(liveCaptures)
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get()).toEqual({ generation, status: "sealed" });
  expect(await (await openLiveCaptureMember(old.archivePath, old.snapshot)).readEntryBuffer(old.snapshot.member.entryName, 64 * 1024)).toEqual(oldBytes);
}, 30_000);

for (const { trimmedPrefixFrames, resumeAfterPrefix } of [
  { trimmedPrefixFrames: 0, resumeAfterPrefix: false },
  { trimmedPrefixFrames: 1, resumeAfterPrefix: false },
  { trimmedPrefixFrames: 1, resumeAfterPrefix: true },
]) {
test(`restart streams historical windows with trim ${trimmedPrefixFrames}, committed prefix ${resumeAfterPrefix}`, async () => {
  const { sourcePath, frames } = await sourcePrefix(36);
  const archivePath = join(root, `archive-${randomUUID()}.bin.gz`);
  const records = [...iterateSessionCaptureRecords(await readFile(sourcePath), 0, { strict: true })]
    .filter((record) => record.kind === "frame");
  const session = await db.insert(sessions).values({ carId: "3631", trackId: "860", gameId: "fm-2023", rawFile: sourcePath })
    .returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const saved = await db.insert(laps).values(Array.from({ length: 8 }, (_, index) => ({
    sessionId: session.id, lapNumber: index, lapTime: 30, rawByteOffset: records[index * 4 + trimmedPrefixFrames]!.offset, rawFrameCount: 4 - trimmedPrefixFrames,
  }))).returning({ id: laps.id }).all();
  const identity = { sessionId: session.id, captureEpoch: randomUUID(), attempt: randomUUID() };
  await beginLiveCapture({ ...identity, sourcePath, archivePath });
  const info = await stat(sourcePath, { bigint: true });
  expect(await bindLiveCaptureSourceIdentity(identity, String(info.dev), String(info.ino))).toBe(true);
  const entries = saved.flatMap((lap, index) => [
    { sequence: index * 3 + 1, sourceByteEnd: records[index * 4]!.offset, payload: {
      kind: "candidate", candidateId: `history-${index}`, startByteOffset: records[index * 4]!.offset, lapNumber: index,
      preparationOnly: false, parserPlan: { gameId: "fm-2023", sequence: 0, anchorSequence: 0, anchorPayload: "", precedingRecords: [] },
    } },
    ...(trimmedPrefixFrames ? [{ sequence: index * 3 + 2, sourceByteEnd: records[index * 4 + 1]!.offset, payload: {
      kind: "candidate", candidateId: `selected-${index}`, startByteOffset: records[index * 4 + 1]!.offset, lapNumber: index,
      preparationOnly: true, parserPlan: { gameId: "fm-2023", sequence: 0, anchorSequence: 0, anchorPayload: "", precedingRecords: [] },
    } }] : []),
    { sequence: index * 3 + 3, sourceByteEnd: records[index * 4 + 4]!.endOffset, payload: {
      kind: "window", revision: index, lapId: lap.id, startByteOffset: records[index * 4 + trimmedPrefixFrames]!.offset, frameCount: 4 - trimmedPrefixFrames,
    } },
  ]);
  expect(await persistLiveCaptureProgress(identity, { sequence: entries.at(-1)!.sequence, sourceByteLength: Number(info.size),
    sourceRecordCount: frames.length, sourceDurableWatermark: Number(info.size), metadataDurableWatermark: Number(info.size) }, entries)).toBe(true);
  let committedPrefix: Buffer<ArrayBuffer> | undefined;
  if (resumeAfterPrefix) {
    const first = records[0]!, digest = createHash("sha256");
    updateNativeRecordDigest(digest, first);
    const bytes = Buffer.concat([encodeMetaFrame(1), encodeFrameLength(first.frame.byteLength, first.frameTimeMs), first.frame]);
    const descriptor: StreamingMemberDescriptor = {
      id: "000001-auxiliary.bin", kind: "auxiliary", firstOrdinal: 0, sourceStart: 0, sourceEnd: 1,
      sourceByteStart: 0, sourceByteEnd: records[1]!.offset, recordCount: 1, ownedFrameCount: 1,
      trailingContextFrameCount: 0, nativeDigest: digest.digest("hex"), byteLength: bytes.byteLength, ownedFrameByteOffset: 12,
    };
    const host = new FileStreamingSplitterHost({ archivePath, maxQueuedBytes: 1024 * 1024, maxUnresolvedBytes: 1024 * 1024,
      async commit(value) {
        const member = Schema.decodeUnknownSync(LiveArchiveMemberSchema)({ ...value, entryName: value.id, generation: 1 });
        if (!await commitLiveCaptureMember({ identity, priorGeneration: 0, member, ownershipRevision: 0,
          verification: { nativeDigest: value.nativeDigest, parserReplayVerified: true } })) {
          throw new Error("Trimmed auxiliary prefix publication was fenced");
        }
        return { generation: 1 };
      },
    });
    const stage = await host.createStage("auxiliary", descriptor.id);
    await stage.append(bytes); await stage.close(); await stage.verify(descriptor);
    await stage.commit({ ...descriptor, parserReplayVerified: true });
    await host.dispose();
    committedPrefix = await readFile(archivePath);
  }
  await setLiveCaptureStatus(identity, "recovering");
  await replayLiveCaptureTail(identity.captureEpoch);
  const state = await db.select({ status: liveCaptures.status, generation: liveCaptures.generation }).from(liveCaptures)
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get();
  expect(state?.status).toBe("sealed");
  if (committedPrefix) expect((await readFile(archivePath)).subarray(0, committedPrefix.byteLength)).toEqual(committedPrefix);
  const snapshot = await getLiveLapCaptureSnapshot(session.id, saved[7]!.id);
  if (!snapshot) throw new Error("Last historical window did not recover");
  const archive = await openLiveCaptureMember(snapshot.archivePath, snapshot.snapshot);
  const decoded = [...iterateSessionCaptureRecords(await archive.readEntryBuffer(snapshot.snapshot.member.entryName, 64 * 1024))]
    .filter((record) => record.kind === "frame");
  expect(decoded.map((record) => record.frame)).toEqual(frames.slice(28 + trimmedPrefixFrames, 32));
  expect(decoded.map((record) => record.frameTimeMs)).toEqual(frames.slice(28 + trimmedPrefixFrames, 32).map((_, index) => (28 + trimmedPrefixFrames + index) * 10));
}, 30_000);
}

test("restart refuses to absorb a persisted unpublished lap without durable authoritative ownership", async () => {
  const { sourcePath } = await sourcePrefix();
  const archivePath = join(root, `archive-${randomUUID()}.bin.gz`);
  const records = [...iterateSessionCaptureRecords(await readFile(sourcePath))].filter((record) => record.kind === "frame");
  const session = await db.insert(sessions).values({ carId: "3631", trackId: "860", gameId: "fm-2023", rawFile: sourcePath })
    .returning({ id: sessions.id }).get();
  sessionIds.push(session.id);
  const lap = await db.insert(laps).values({ sessionId: session.id, lapNumber: 0, lapTime: 30,
    rawByteOffset: records[0]!.offset, rawFrameCount: 4 }).returning({ id: laps.id }).get();
  const identity = { sessionId: session.id, captureEpoch: randomUUID(), attempt: randomUUID() };
  await beginLiveCapture({ ...identity, sourcePath, archivePath });
  const info = await stat(sourcePath, { bigint: true });
  await bindLiveCaptureSourceIdentity(identity, String(info.dev), String(info.ino));
  await persistLiveCaptureProgress(identity, { sequence: 0, sourceByteLength: Number(info.size), sourceRecordCount: 16,
    sourceDurableWatermark: Number(info.size), metadataDurableWatermark: Number(info.size) }, []);
  await setLiveCaptureStatus(identity, "recovering");
  await expect(replayLiveCaptureTail(identity.captureEpoch)).rejects.toThrow();
  expect(await getLiveLapCaptureSnapshot(session.id, lap.id)).toBeNull();
  expect(await db.select({ generation: liveCaptureMembers.generation }).from(liveCaptureMembers)
    .where(eq(liveCaptureMembers.captureEpoch, identity.captureEpoch)).all()).toEqual([]);
  expect(await db.select({ status: liveCaptures.status }).from(liveCaptures)
    .where(eq(liveCaptures.captureEpoch, identity.captureEpoch)).get()).toEqual({ status: "failed" });
}, 30_000);
